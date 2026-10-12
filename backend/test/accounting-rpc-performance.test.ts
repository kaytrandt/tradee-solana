import assert from 'node:assert/strict';
import test from 'node:test';
import { SolanaAccountingRpcGateway } from '../src/modules/accounting/infrastructure/solana/solana-accounting-rpc-gateway.js';

const wallet = { userId: 'test-user', walletId: 'test-wallet', address: 'test-address' };
const transaction = (slot = 10) => ({ slot, blockTime: 1_700_000_000, transaction: {},
  meta: { err: null, preTokenBalances: [], postTokenBalances: [] } });
const response = (result: unknown) => new Response(JSON.stringify({ result }));
const configuration = { rpcUrl: 'https://primary.invalid', timeoutMs: 1000, maxAttempts: 1, retryBaseDelayMs: 0 };

test('concurrent finalized reads coalesce but never persist a transaction or null response', async () => {
  let txCalls = 0; let blockCalls = 0; let pending = true;
  const gateway = new SolanaAccountingRpcGateway(configuration, async (_url, options) => {
    const { method, params } = JSON.parse(String(options?.body));
    assert.equal(params[1].commitment, 'finalized');
    await new Promise(resolve => setImmediate(resolve));
    if (method === 'getTransaction') { txCalls++; return response(pending ? null : transaction()); }
    blockCalls++; return response({ signatures: ['one', 'two'] });
  });
  const missing = await Promise.allSettled([gateway.fetchFinalizedTransaction('one', wallet),
    gateway.fetchFinalizedTransactionMetadata('one')]);
  assert.ok(missing.every(value => value.status === 'rejected'));
  assert.equal(txCalls, 1); assert.equal(blockCalls, 0);
  pending = false;
  const [first, second] = await Promise.all([gateway.fetchFinalizedTransaction('one', wallet),
    gateway.fetchFinalizedTransaction('one', { ...wallet, walletId: 'another-wallet' }),
    gateway.fetchFinalizedTransactionMetadata('one')]);
  assert.notEqual(first.chainTransactionId, second.chainTransactionId);
  assert.equal(txCalls, 2); assert.equal(blockCalls, 1);
  assert.equal((await gateway.fetchFinalizedTransaction('two', wallet)).transactionIndex, 1);
  assert.equal(txCalls, 3); assert.equal(blockCalls, 1);
});

test('block cache expires, is bounded and never fabricates a missing transaction index', async () => {
  let clock = 0; let slot = 10; let calls = 0; let signatures: unknown[] = ['one'];
  const timings: Readonly<Record<string, unknown>>[] = [];
  const gateway = new SolanaAccountingRpcGateway({ ...configuration, onTiming: value => timings.push(value) },
    async (_url, options) => {
      const { method } = JSON.parse(String(options?.body));
      if (method === 'getTransaction') return response(transaction(slot));
      calls++; return response({ signatures });
    }, () => new Date(clock));
  await gateway.fetchFinalizedTransaction('one', wallet);
  await gateway.fetchFinalizedTransaction('one', wallet);
  assert.equal(calls, 1); assert.equal(timings[1]?.blockCacheHit, true);
  clock = 60_001;
  await gateway.fetchFinalizedTransaction('one', wallet);
  assert.equal(calls, 2); assert.equal(timings[2]?.blockCacheHit, false);
  await assert.rejects(gateway.fetchFinalizedTransaction('missing', wallet), /missing from its finalized block/);
  signatures = ['one', 'missing'];
  assert.equal((await gateway.fetchFinalizedTransaction('missing', wallet)).transactionIndex, 1);
  // More than 64 distinct finalized slots evicts the oldest slot.
  for (slot = 11; slot <= 75; slot++) await gateway.fetchFinalizedTransaction('one', wallet);
  const before = calls; slot = 10;
  await gateway.fetchFinalizedTransaction('one', wallet);
  assert.equal(calls, before + 1);
  slot = 99; signatures = ['one', 123];
  await assert.rejects(gateway.fetchFinalizedTransaction('one', wallet), /Block signatures are invalid/);
  signatures = ['one'];
  await gateway.fetchFinalizedTransaction('one', wallet);
  assert.equal(timings.at(-1)?.blockCacheHit, false);
});

test('successful fallback gets temporary method affinity; expiry and null retry primary', async () => {
  let clock = 0; let primaryReady = false; let fallbackReady = true;
  const calls: string[] = [];
  const gateway = new SolanaAccountingRpcGateway({ ...configuration, fallbackRpcUrls: ['https://fallback.invalid'] },
    async url => {
      calls.push(String(url));
      return response((String(url).includes('primary') ? primaryReady : fallbackReady) ? transaction() : null);
    }, () => new Date(clock));
  await gateway.fetchFinalizedTransactionMetadata('one');
  await gateway.fetchFinalizedTransactionMetadata('two');
  assert.deepEqual(calls, ['https://primary.invalid', 'https://fallback.invalid', 'https://fallback.invalid']);
  clock = 30_001; primaryReady = true;
  await gateway.fetchFinalizedTransactionMetadata('three');
  assert.equal(calls.at(-1), 'https://primary.invalid');
  primaryReady = false;
  await gateway.fetchFinalizedTransactionMetadata('four');
  fallbackReady = false; primaryReady = true;
  await gateway.fetchFinalizedTransactionMetadata('five');
  assert.deepEqual(calls.slice(-2), ['https://fallback.invalid', 'https://primary.invalid']);
});
