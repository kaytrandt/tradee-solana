import assert from "node:assert/strict";
import test from "node:test";
import { decimalString } from "../src/modules/assets/domain/asset.js";
import { AccountingEventNormalizer } from "../src/modules/accounting/application/accounting-event-normalizer.js";
import { AssetQuantityConverter } from "../src/modules/accounting/application/asset-quantity-converter.js";
import { PositionEngine } from '../src/modules/accounting/application/position-engine.js';
import {
  AccountingError,
  AccountingEventType,
  ChainFinality,
  type AccountingContextResolver,
  type AccountingTradeContext,
  type ChainObservationBatch,
} from "../src/modules/accounting/domain/accounting.js";

const now = new Date("2026-09-01T00:10:00.000Z");
test('USDC referral is cash reward, not external deposit or stock position',async()=>{
  const contexts: AccountingContextResolver = {resolveTrade:async()=>null,findAssetByMint:async()=>null,
    resolveHint:async()=>({type:AccountingEventType.REFERRAL_REWARD,asset:null,mint:'usdc-mint',rewardId:'payout',metadata:{expectedUsdcBaseUnits:'600000'}})};
  const service = new AccountingEventNormalizer(contexts,new AssetQuantityConverter(),{
    buyFeeCostBasis:'EXPENSE',rewardCostBasis:'RECEIPT_VALUE',recognizedDepositMint:'usdc-mint',externalClassificationDelayMs:0},()=>now);
  const input=batch('IN','1','IN','600000');
  const result=await service.normalize({...input,observations:input.observations.slice(1)});
  assert.equal(result.events[0]?.type,AccountingEventType.REFERRAL_REWARD);
  assert.equal(result.events[0]?.displayQuantity,'0.6');
  assert.equal(result.events[0]?.affectsPosition,false);
  assert.equal(result.events[0]?.costBasisTreatment,'INFORMATIONAL');
  await assert.rejects(service.normalize({...input,observations:input.observations.slice(1).map(o=>({...o,rawQuantity:'600001'}))}),/immutable payout/);
});
const asset = {
  assetId: "asset-1",
  mint: "stock-mint",
  decimals: 2,
  quantityMultiplier: decimalString("1"),
  quantityModelVersion: 2,
};
const trade: AccountingTradeContext = {
  orderId: "order-1",
  executionId: "execution-1",
  side: "BUY",
  asset,
  usdcMint: "usdc-mint",
  usdcDecimals: 6,
  grossInputAmount: "100000000",
  economicTradingAmount: "99500000",
  netOutputAmount: "2500",
  minimumOutputAmount: "2475",
  feeAmount: "500000",
};

test('migration carries exact full basis atomically without sale PnL, and rejects mismatches',async()=>{
  const prior=(await normalizer(context({trade}),'EXPENSE').normalize(batch('IN','2500','OUT','100000000'))).events;
  const target={...asset,assetId:'sunrise',mint:'sunrise-mint',decimals:6,quantityMultiplier:decimalString('1.0001068370781347')};
  const resolver=context({trade:null});
  resolver.resolveMigration=async()=>({pending:false,id:'migration-1',source:asset,destination:target,rawAmount:'2500',minimumOutput:'895500',costBasis:decimalString('99.5')});
  const original=batch('OUT','2500','IN','900000');
  const migrated:ChainObservationBatch={...original,slot:2n,signature:'migration-sig',observations:original.observations.map((o,i)=>({...o,slot:2n,sourceKey:`migration-${i}`,signature:'migration-sig',mint:i===0?asset.mint:target.mint}))};
  const result=await normalizer(resolver,'EXPENSE').normalize(migrated);
  assert.deepEqual(result.events.map(e=>e.type),['TRANSFER_OUT','TRANSFER_IN']);
  const engine=new PositionEngine(),source=engine.rebuild({userId:'user-1',walletId:'wallet-1',assetId:asset.assetId,events:[...prior,...result.events]});
  const destination=engine.rebuild({userId:'user-1',walletId:'wallet-1',assetId:target.assetId,events:result.events});
  assert.equal(source.rawQuantity,'0');assert.equal(source.totalCostBasis,'0');assert.equal(source.realizedPnl,'0');
  assert.equal(destination.rawQuantity,'900000');assert.equal(destination.totalCostBasis,'99.5');assert.equal(destination.realizedPnl,'0');
  assert.equal(destination.displayQuantity,'0.90009615337032123');
  assert.throws(()=>engine.rebuild({userId:'user-1',walletId:'wallet-1',assetId:asset.assetId,events:[...prior,...result.events.map(e=>({...e,metadata:{...e.metadata,carriedCostBasis:'98'}}))]}),/canonical event time/);
  await assert.rejects(normalizer(resolver,'EXPENSE').normalize({...migrated,observations:migrated.observations.map((o,i)=>i===1?{...o,rawQuantity:'1'}:o)}),/finalized movements/);
  resolver.resolveMigration=async()=>({pending:true});
  assert.equal((await normalizer(resolver,'EXPENSE',0).normalize(migrated)).state,'pending');
  const deposit=batch('IN','1','IN','1000000');
  const depositResult=await normalizer(resolver,'EXPENSE',0).normalize({...deposit,observations:deposit.observations.slice(1)});
  assert.equal(depositResult.state,'normalized');
  assert.equal(depositResult.events[0]?.type,AccountingEventType.DEPOSIT);
});

test("receipt-backed free stock uses grant capital and exact finalized quantity, never user cash", async () => {
  const contexts: AccountingContextResolver = { resolveTrade: async()=>null, findAssetByMint:async()=>asset,
    resolveHint: async()=>({type:AccountingEventType.FREE_STOCK,asset,mint:asset.mint,rewardId:"grant",
      acquisition:{value:decimalString("3"),receivedBaseUnits:"2500"}, metadata:{}}) };
  const service = new AccountingEventNormalizer(contexts,new AssetQuantityConverter(),{
    buyFeeCostBasis:"EXPENSE",rewardCostBasis:"RECEIPT_VALUE",recognizedDepositMint:"usdc-mint",externalClassificationDelayMs:0},()=>now);
  const result = await service.normalize(batch("IN","2500","OUT","100000000"));
  assert.equal(result.events.length,1);
  assert.equal(result.events[0]?.totalValue,"3");
  assert.equal(result.events[0]?.quoteAmount,null);
  assert.equal(result.events[0]?.costBasisTreatment,"KNOWN_ACQUISITION");
  assert.equal(result.events[0]?.displayQuantity,"25");
  await assert.rejects(service.normalize(batch("IN","2501","OUT","100000000")),/receipt quantity/);
});

test("BUY excludes actual fee even with legacy CAPITALIZE configuration and emits informational fee", async () => {
  const result = await normalizer(context({ trade }), "CAPITALIZE").normalize(batch("IN", "2500", "OUT", "100000000"));
  assert.equal(result.state, "normalized");
  assert.equal(result.events.length, 2);
  const buy = result.events[0];
  const fee = result.events[1];
  assert.equal(buy?.type, AccountingEventType.BUY);
  assert.equal(buy?.totalValue, "99.5");
  assert.equal(buy?.feeAmount, "0.5");
  assert.equal(buy?.tradeOrderId, "order-1");
  assert.equal(buy?.tradeExecutionId, "execution-1");
  assert.equal(fee?.type, AccountingEventType.FEE);
  assert.equal(fee?.affectsPosition, false);
  assert.equal(fee?.rawQuantity, "500000");
  assert.equal(fee?.metadata.economicEffect, "INFORMATIONAL_ONLY");
});

test("BUY EXPENSE policy uses swap amount as cost basis", async () => {
  const result = await normalizer(context({ trade }), "EXPENSE").normalize(batch("IN", "2500", "OUT", "100000000"));
  assert.equal(result.events[0]?.totalValue, "99.5");
  assert.equal(result.events[0]?.quoteAmount, "100");
});

test("BUY records favorable finalized output instead of rejecting a quote variance", async () => {
  const result = await normalizer(context({ trade }), "CAPITALIZE").normalize(batch("IN", "2501", "OUT", "100000000"));
  assert.equal(result.events[0]?.rawQuantity, "2501");
  assert.equal(result.events[0]?.metadata.quotedOutputRawQuantity, "2500");
  assert.equal(result.events[0]?.metadata.actualOutputRawQuantity, "2501");
});

test("BUY uses the finalized wallet debit and does not invent an unobserved input fee", async () => {
  const result = await normalizer(context({ trade }), "CAPITALIZE").normalize(batch("IN", "2500", "OUT", "99500000"));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.quoteAmount, "99.5");
  assert.equal(result.events[0]?.totalValue, "99.5");
  assert.equal(result.events[0]?.feeAmount, "0");
  assert.equal(result.events[0]?.metadata.quotedFeeRawQuantity, "500000");
  assert.equal(result.events[0]?.metadata.observedFeeRawQuantity, "0");
});

test("atomic BUY keeps the exact fee and accounts only for actual swap spend when input remains", async () => {
  const buy = { ...trade, exactFee: true, grossInputAmount: "2000000", economicTradingAmount: "1825000",
    feeAmount: "175000", netOutputAmount: "3387", minimumOutputAmount: "3371" };
  const service = normalizer(context({ trade: buy }), "EXPENSE");
  const result = await service.normalize(batch("IN", "3394", "OUT", "1999472"));
  assert.equal(result.events[0]?.quoteAmount, "1.999472");
  assert.equal(result.events[0]?.totalValue, "1.824472");
  assert.equal(result.events[0]?.feeAmount, "0.175");
  assert.equal(result.events[1]?.rawQuantity, "175000");
  assert.equal((await service.normalize(batch("IN", "3394", "OUT", "1824999"))).events[0]?.totalValue, "1.649999");
  for (const [input, output] of [["2000001", "3394"], ["175000", "3394"], ["0", "3394"], ["1999472", "3370"]]) {
    await assert.rejects(service.normalize(batch("IN", output!, "OUT", input!)),
      (error) => error instanceof AccountingError && error.code === "ACCOUNTING_CHAIN_CONTEXT_MISMATCH");
  }
});

test("SELL uses net USDC proceeds and never deducts fee twice", async () => {
  const sell = { ...trade, side: "SELL" as const, grossInputAmount: "2500", economicTradingAmount: "2500", netOutputAmount: "99500000", minimumOutputAmount: "99000000" };
  const result = await normalizer(context({ trade: sell }), "CAPITALIZE").normalize(batch("OUT", "2500", "IN", "99500000"));
  assert.equal(result.events[0]?.type, AccountingEventType.SELL);
  assert.equal(result.events[0]?.totalValue, "99.5");
  assert.equal(result.events[0]?.feeAmount, "0.5");
});

test("SELL records favorable finalized net proceeds", async () => {
  const sell = { ...trade, side: "SELL" as const, grossInputAmount: "2500", economicTradingAmount: "2500", netOutputAmount: "99500000", minimumOutputAmount: "99000000" };
  const result = await normalizer(context({ trade: sell }), "CAPITALIZE").normalize(batch("OUT", "2500", "IN", "99600000"));
  assert.equal(result.events[0]?.quoteAmount, "99.6");
  assert.equal(result.events[0]?.totalValue, "99.6");
});

test("SELL records actual debit below maximum input and rejects overspend or insufficient proceeds", async () => {
  const sell = { ...trade, side: "SELL" as const,
    asset: { ...asset, decimals: 8 }, grossInputAmount: "903241", economicTradingAmount: "903241",
    minimumOutputAmount: "2792131", netOutputAmount: "2806161", feeAmount: "99970" };
  const service = normalizer(context({ trade: sell }), "CAPITALIZE");
  const result = await service.normalize(batch("OUT", "900298", "IN", "2797019"));
  assert.equal(result.events[0]?.rawQuantity, "900298");
  assert.equal(result.events[0]?.displayQuantity, "0.00900298");
  assert.equal(result.events[0]?.totalValue, "2.797019");
  for (const [input, output] of [["903242", "2797019"], ["900298", "2792130"], ["0", "2797019"]]) {
    await assert.rejects(service.normalize(batch("OUT", input!, "IN", output!)),
      (error) => error instanceof AccountingError && error.code === "ACCOUNTING_CHAIN_CONTEXT_MISMATCH");
  }
});

test("trade observation mismatch fails closed", async () => {
  await assert.rejects(
    normalizer(context({ trade }), "CAPITALIZE").normalize(batch("IN", "2500", "OUT", "99499999")),
    (error) => error instanceof AccountingError && error.code === "ACCOUNTING_CHAIN_CONTEXT_MISMATCH",
  );
});

test("trade output below the quoted minimum fails closed", async () => {
  await assert.rejects(
    normalizer(context({ trade }), "CAPITALIZE").normalize(batch("IN", "2474", "OUT", "100000000")),
    (error) => error instanceof AccountingError && error.code === "ACCOUNTING_CHAIN_CONTEXT_MISMATCH",
  );
});

test("young unclassified transactions remain pending to avoid internal-context races", async () => {
  const young = { ...batch("IN", "2500", "OUT", "100000000"), blockTime: new Date(now.getTime() - 1_000) };
  const result = await normalizer(context({ trade: null }), "CAPITALIZE", 120_000).normalize(young);
  assert.deepEqual(result, { state: "pending", reason: "awaiting_internal_context", events: [] });
});

test("young unambiguous canonical USDC deposit bypasses the internal-context delay", async () => {
  const source = batch("OUT", "2500", "IN", "1000000");
  const young = {
    ...source,
    blockTime: new Date(now.getTime() - 1_000),
    observations: source.observations.filter((observation) => observation.mint === "usdc-mint"),
  };
  const result = await normalizer(context({ trade: null }), "CAPITALIZE", 120_000).normalize(young);
  assert.equal(result.state, "normalized");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.type, AccountingEventType.DEPOSIT);
  assert.equal(result.events[0]?.displayQuantity, "1");
});

test("young inbound USDC with another token movement still waits for trade context", async () => {
  const young = { ...batch("OUT", "2500", "IN", "1000000"), blockTime: new Date(now.getTime() - 1_000) };
  const result = await normalizer(context({ trade: null }), "CAPITALIZE", 120_000).normalize(young);
  assert.deepEqual(result, { state: "pending", reason: "awaiting_internal_context", events: [] });
});

test('finalized single incoming stock is received immediately, without cash credit or the context grace period', async () => {
  const source = batch('IN', '2500', 'OUT', '100000000');
  const young = {...source, blockTime: new Date(now.getTime() - 1000), observations: source.observations.slice(0, 1)};
  const resolver = context({trade: null, findAsset: true});
  const result = await normalizer(resolver, 'EXPENSE').normalize(young);
  assert.equal(result.state, 'normalized');
  assert.deepEqual(result.events.map(e => e.type), ['TRANSFER_IN']);
  assert.equal(result.events[0]?.rawQuantity, '2500');
  assert.equal(result.events[0]?.quoteAmount, null);
  assert.equal((await normalizer(resolver, 'EXPENSE').normalize({...young, finality: ChainFinality.CONFIRMED})).state, 'pending');
  assert.equal((await normalizer(context({trade: null}), 'EXPENSE').normalize(young)).state, 'pending');
  resolver.resolveMigration = async () => ({pending: true});
  assert.equal((await normalizer(resolver, 'EXPENSE').normalize(young)).reason, 'awaiting_migration_confirmation');
});

test("mature external xStock transfer has explicitly unknown basis", async () => {
  const external = batch("IN", "2500", "OUT", "100000000");
  const result = await normalizer(context({ trade: null, findAsset: true }), "CAPITALIZE", 0).normalize(external);
  assert.equal(result.events.length, 2);
  assert.equal(result.events.find(event => event.type === AccountingEventType.WITHDRAW)?.displayQuantity, "100");
  assert.equal(result.events[0]?.type, AccountingEventType.TRANSFER_IN);
  assert.equal(result.events[0]?.totalValue, null);
  assert.equal(result.events[0]?.displayQuantity, "25");
});

test("incoming canonical Solana USDC is the only external cash deposit classification", async () => {
  const external = batch("OUT", "2500", "IN", "1234567");
  const result = await normalizer(context({ trade: null, findAsset: false }), "CAPITALIZE", 0).normalize(external);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.type, AccountingEventType.DEPOSIT);
  assert.equal(result.events[0]?.displayQuantity, "1.234567");
  assert.equal(result.events[0]?.affectsPosition, false);
});

test("reward requires immutable reward identity and never fabricates zero basis", async () => {
  const resolver = context({ trade: null });
  resolver.resolveHint = async () => ({
    type: AccountingEventType.FREE_STOCK,
    asset,
    mint: asset.mint,
    rewardId: "reward-1",
    metadata: {},
  });
  const result = await normalizer(resolver, "CAPITALIZE").normalize(batch("IN", "2500", "OUT", "100000000"));
  assert.equal(result.events[0]?.type, AccountingEventType.FREE_STOCK);
  assert.equal(result.events[0]?.rewardId, "reward-1");
  assert.equal(result.events[0]?.totalValue, null);
});

test("non-USDC funding hint fails closed", async () => {
  const resolver = context({ trade: null });
  resolver.resolveHint = async () => ({
    type: AccountingEventType.DEPOSIT,
    asset: null,
    mint: asset.mint,
    rewardId: null,
    metadata: {},
  });
  await assert.rejects(
    normalizer(resolver, "CAPITALIZE").normalize(batch("IN", "2500", "OUT", "100000000")),
    (error) => error instanceof AccountingError && error.code === "ACCOUNTING_CHAIN_CONTEXT_MISMATCH",
  );
});

function normalizer(
  resolver: AccountingContextResolver,
  policy: "CAPITALIZE" | "EXPENSE",
  externalClassificationDelayMs = 120_000,
) {
  return new AccountingEventNormalizer(
    resolver,
    new AssetQuantityConverter(),
    {
      buyFeeCostBasis: policy,
      rewardCostBasis: "UNAVAILABLE",
      recognizedDepositMint: "usdc-mint",
      externalClassificationDelayMs,
    },
    () => now,
  );
}

function context(input: { readonly trade: AccountingTradeContext | null; readonly findAsset?: boolean }): AccountingContextResolver {
  return {
    resolveTrade: async () => input.trade,
    resolveHint: async () => null,
    findAssetByMint: async (mint) => input.findAsset === true && mint === asset.mint ? asset : null,
  };
}

function batch(
  assetDirection: "IN" | "OUT",
  assetRaw: string,
  cashDirection: "IN" | "OUT",
  cashRaw: string,
): ChainObservationBatch {
  const blockTime = new Date("2026-09-01T00:00:00.000Z");
  const observation = (mint: string, direction: "IN" | "OUT", rawQuantity: string, eventIndex: number) => ({
    observationId: `observation-${eventIndex}`,
    sourceKey: `solana:signature-1:balance:${mint}:wallet-address`,
    userId: "user-1",
    walletId: "wallet-1",
    walletAddress: "wallet-address",
    signature: "signature-1",
    slot: 1n,
    transactionIndex: 0,
    eventIndex,
    mint,
    decimals: mint === asset.mint ? 2 : 6,
    direction,
    rawQuantity,
    occurredAt: blockTime,
    observedAt: now,
    finality: ChainFinality.FINALIZED,
  });
  return {
    chainTransactionId: "chain-transaction-1",
    userId: "user-1",
    walletId: "wallet-1",
    walletAddress: "wallet-address",
    signature: "signature-1",
    slot: 1n,
    transactionIndex: 0,
    blockTime,
    finality: ChainFinality.FINALIZED,
    observations: [
      observation(asset.mint, assetDirection, assetRaw, 0),
      observation("usdc-mint", cashDirection, cashRaw, 1),
    ],
    rawMetadata: {},
  };
}
