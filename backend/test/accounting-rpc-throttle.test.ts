import assert from 'node:assert/strict';
import test from 'node:test';
import { SolanaAccountingRpcGateway, parseRetryAfter } from '../src/modules/accounting/infrastructure/solana/solana-accounting-rpc-gateway.js';
import { AccountingRpcWorkload } from '../src/modules/accounting/infrastructure/solana/accounting-rpc-workload.js';
const config = { rpcUrl: 'https://primary.invalid/private?key=secret', fallbackRpcUrls: ['https://fallback.invalid'], timeoutMs: 1000, maxAttempts: 3, retryBaseDelayMs: 0 };
const ok = (result: unknown) => new Response(JSON.stringify({ result }));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('Retry-After accepts seconds and HTTP dates, rejects garbage', () => {
  assert.equal(parseRetryAfter('15', 0), 15000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60000);
  assert.equal(parseRetryAfter('garbage', 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
});

test('429 cooldown spans methods, honors Retry-After, fails over and never logs endpoint secrets', async () => {
  let now = 0;
  const calls: string[] = [], logs: unknown[] = [];
  const gateway = new SolanaAccountingRpcGateway({ ...config, onTiming: x => logs.push(x) }, async (url, init) => {
    calls.push(`${String(url).split('/')[2]}:${JSON.parse(String(init?.body)).method}`);
    return String(url).includes('primary') ? new Response('', {status:429,headers:{'Retry-After':'120'}}) : ok({ value: [] });
  }, () => new Date(now));
  assert.equal(await gateway.getTokenBalance('owner','mint'), '0');
  await gateway.listTokenAccountAddresses('owner','mint');
  assert.equal(calls.filter(x => x.startsWith('primary')).length, 1);
  now = 119999; await gateway.listOwnedTokenAccountAddresses('owner');
  assert.equal(calls.filter(x => x.startsWith('primary')).length, 1);
  now = 150001; await gateway.listTokenAccountAddresses('owner','mint');
  assert.equal(calls.filter(x => x.startsWith('primary')).length, 2);
  assert.ok(!JSON.stringify(logs).includes('secret'));
  assert.ok(JSON.stringify(logs).includes('primary.invalid'));
});

test('all endpoints cooling down fail quickly without extra HTTP calls; success cannot erase a concurrent 429', async () => {
  let calls = 0, release!: (r: Response) => void;
  const gateway = new SolanaAccountingRpcGateway({ ...config, fallbackRpcUrls: [] }, async () => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return new Response('', {status:429,headers:{'Retry-After':'30'}});
  });
  const first = gateway.getTokenBalance('owner','a'); await flush();
  await assert.rejects(gateway.getTokenBalance('owner','b'), {code:'ACCOUNTING_RPC_RATE_LIMITED'});
  release(ok({value:[]})); await first;
  await assert.rejects(gateway.getTokenBalance('owner','c'), {code:'ACCOUNTING_RPC_COOLDOWN'});
  assert.equal(calls, 2);
});

test('background requests are paced and serialized while foreground skips the lane', async () => {
  let now = 0, release!: () => void;
  const sleeps: number[] = [], events: string[] = [];
  const lane = new AccountingRpcWorkload(1000, () => now, async ms => { sleeps.push(ms); now += ms; });
  const first = lane.runBackground(() => lane.request(async () => {events.push('background1'); await new Promise<void>(r => {release=r;});}));
  await flush();
  const second = lane.runBackground(() => lane.request(async () => {events.push('background2');}));
  await lane.request(async () => {events.push('foreground');});
  assert.deepEqual(events, ['background1','foreground']);
  release(); await Promise.all([first,second]);
  assert.deepEqual(events,['background1','foreground','background2']); assert.deepEqual(sleeps,[1000]);
});

test('wallet snapshot sums exact accounts across both token programs and rejects partial results', async () => {
  let calls = 0, failSecond = false;
  const gateway = new SolanaAccountingRpcGateway({...config, fallbackRpcUrls:[],maxAttempts:1}, async (_url, init) => {
    const {params} = JSON.parse(String(init?.body)); calls++;
    const programId = params[1].programId;
    assert.equal(params[2].commitment,'finalized');
    if (failSecond && programId.startsWith('Tokenz')) return new Response('',{status:503});
    return ok({value:[{account:{owner:programId,data:{parsed:{type:'account',info:{owner:'owner',mint:'mint',tokenAmount:{amount:'9007199254740993123'}}}}}}]});
  });
  assert.equal((await gateway.getWalletTokenBalances('owner')).get('mint'),'18014398509481986246');
  assert.equal(calls,2);
  failSecond=true; await assert.rejects(gateway.getWalletTokenBalances('owner'));
});

test('foreground transaction does not coalesce behind background read of same signature', async () => {
  let calls = 0, release!: (value: Response) => void;
  const gateway = new SolanaAccountingRpcGateway(config, async () => {
    calls++;
    if (calls===1) return new Promise<Response>(r=>{release=r;});
    return ok({slot:1,meta:{err:null},transaction:{}});
  });
  const background = gateway.workload.runBackground(() => gateway.fetchFinalizedTransactionMetadata('sig'));
  await flush();
  await gateway.fetchFinalizedTransactionMetadata('sig');
  assert.equal(calls,2);
  release(ok({slot:1,meta:{err:null},transaction:{}})); await background;
});
