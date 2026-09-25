import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { TradingPolicyService } from "../src/modules/transaction-policy/application/trading-policy-service.js";
import {
  TradingChain,
  TradingPolicyError,
  TradingSide,
  TradingWhitelistStatus,
  validateTradingWhitelistConfiguration,
  type TradingEligibilityContext,
  type TradingEligibilityDecision,
  type TradingPolicyAssetLookup,
  type TradingWhitelist,
  type TradingWhitelistLookup,
  type UserTradingEligibilityService,
  type WalletTradingEligibilityService,
} from "../src/modules/transaction-policy/domain/trading-policy.js";
import { decimalString, type Asset } from "../src/modules/assets/domain/asset.js";
import { PostgresTradingWhitelistRepository } from "../src/modules/transaction-policy/infrastructure/postgres/postgres-trading-whitelist-repository.js";

const validatedAt = new Date("2026-08-31T12:00:00.000Z");
const asset = sampleAsset();
const wallet = { address: "SolanaWallet111", chain: TradingChain.SOLANA } as const;

test("retail BUY accepts exactly $1 and rejects every positive value below it", async () => {
  const service = policyService({ whitelists: new WhitelistLookupStub(activeWhitelist({
    minBuyAmount: decimalString("1"), maxBuyAmount: null,
  })) });
  for (const amount of ["0.01", "0.50", "0.99", "0.999999"]) {
    await expectPolicyError(service.validateTrade(request({ amount })), "amount_below_minimum");
  }
  for (const amount of ["1", "1.00", "1.000001", "1.01"]) {
    assert.ok(await service.validateTrade(request({ amount })));
  }
});

test("inclusive-minimum migration is idempotent and preserves custom limits, fees and permissions", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE trading_whitelists(id text, min_buy_amount numeric,
      max_buy_amount numeric, buy_enabled boolean, sell_enabled boolean, fee_bps int,
      status text, updated_at timestamptz);
      INSERT INTO trading_whitelists VALUES
        ('legacy',1.000001,NULL,true,true,50,'ACTIVE',NOW()),
        ('disabled',1.000001,100,false,false,25,'DISABLED',NOW()),
        ('custom',10,200,true,false,10,'ACTIVE',NOW()),
        ('unlimited',NULL,NULL,true,true,0,'ACTIVE',NOW());`);
    const sql = await readFile("migrations/083_inclusive_buy_minimum.sql", "utf8");
    await db.exec(sql);
    await db.exec(sql);
    const result = await db.query(`SELECT id, min_buy_amount::text AS minimum, max_buy_amount::text AS maximum,
      buy_enabled, sell_enabled, fee_bps, status FROM trading_whitelists ORDER BY id`);
    assert.deepEqual(result.rows, [
      {id:'custom',minimum:'10',maximum:'200',buy_enabled:true,sell_enabled:false,fee_bps:10,status:'ACTIVE'},
      {id:'disabled',minimum:'1',maximum:'100',buy_enabled:false,sell_enabled:false,fee_bps:25,status:'DISABLED'},
      {id:'legacy',minimum:'1',maximum:null,buy_enabled:true,sell_enabled:true,fee_bps:50,status:'ACTIVE'},
      {id:'unlimited',minimum:null,maximum:null,buy_enabled:true,sell_enabled:true,fee_bps:0,status:'ACTIVE'},
    ]);
  } finally { await db.close(); }
});

test("migration grants retirement exception only to its source, with destination and owner gates intact", async () => {
  let source=sampleAsset({active:false});
  let destination=sampleAsset({id:'replacement',solanaMint:'ReplacementMint'});
  let enabled=true;
  const eligibility=new EligibilityStub(true);
  const service=new TradingPolicyService({findById:async id=>id===source.id?source:destination},
    new WhitelistLookupStub(activeWhitelist()),eligibility,eligibility,()=>validatedAt,
    {pair:async()=>({enabled,sourceAssetId:source.id,destinationAssetId:destination.id})});
  const migration={pairId:'pair',userId:'u',wallet,amount:'1'};
  await service.validateMigration(migration);
  assert.deepEqual(eligibility.calls.map(c=>c.side),['SELL','SELL','BUY','BUY']);
  await expectPolicyError(service.validateTrade(request()),'asset_inactive');
  source={...source,providerTradingHalted:true};
  await expectPolicyError(service.validateMigration(migration),'asset_trading_halted');
  source={...source,providerTradingHalted:false};destination={...destination,active:false};
  await expectPolicyError(service.validateMigration(migration),'asset_inactive');
  destination={...destination,active:true};enabled=false;
  await expectPolicyError(service.validateMigration(migration),'asset_trading_disabled');
});

test("one-dollar treasury reward retains eligibility gates without weakening retail minimum", async () => {
  const service=policyService({whitelists:new WhitelistLookupStub(activeWhitelist({minBuyAmount:decimalString("1.000001")}))});
  await expectPolicyError(service.validateTrade(request({amount:"1"})),"amount_below_minimum");
  assert.equal((await service.validateReward(request({amount:"1"}))).amount,"1");
  await expectPolicyError(service.validateReward(request({amount:"0.99"})),"invalid_trade_amount");
  const disabled=policyService({whitelists:new WhitelistLookupStub(activeWhitelist({buyEnabled:false}))});
  await expectPolicyError(disabled.validateReward(request({amount:"1"})),"buy_disabled");
});

test("unknown asset is rejected before whitelist lookup", async () => {
  const assets = new AssetLookupStub(null);
  const whitelists = new WhitelistLookupStub(activeWhitelist());
  const service = policyService({ assets, whitelists });

  await expectPolicyError(service.validateTrade(request()), "asset_not_found");
  assert.equal(whitelists.calls, 0);
});

test("inactive, unavailable, halted, and mintless assets fail closed before whitelist lookup", async () => {
  const cases: readonly [Asset, TradingPolicyError["code"]][] = [
    [sampleAsset({ active: false }), "asset_inactive"],
    [sampleAsset({ providerAvailable: false }), "asset_provider_unavailable"],
    [sampleAsset({ providerTradingHalted: true }), "asset_trading_halted"],
    [sampleAsset({ solanaMint: "" }), "asset_provider_unavailable"],
    [sampleAsset({ provider: 'sunrise', multiplier: null }), 'asset_provider_unavailable'],
  ];

  for (const [candidate, code] of cases) {
    const whitelists = new WhitelistLookupStub(activeWhitelist());
    const service = policyService({ assets: new AssetLookupStub(candidate), whitelists });
    await expectPolicyError(service.validateTrade(request()), code);
    assert.equal(whitelists.calls, 0);
  }
});

test("missing whitelist fails closed", async () => {
  const service = policyService({ whitelists: new WhitelistLookupStub(null) });
  await expectPolicyError(service.validateTrade(request()), "asset_not_whitelisted");
});

test("disabled whitelist fails closed", async () => {
  const service = policyService({
    whitelists: new WhitelistLookupStub(activeWhitelist({ status: TradingWhitelistStatus.DISABLED })),
  });
  await expectPolicyError(service.validateTrade(request()), "asset_trading_disabled");
});

test("BUY and SELL permissions are enforced independently", async () => {
  const buyService = policyService({
    whitelists: new WhitelistLookupStub(activeWhitelist({ buyEnabled: false })),
  });
  await expectPolicyError(buyService.validateTrade(request()), "buy_disabled");

  const sellService = policyService({
    whitelists: new WhitelistLookupStub(activeWhitelist({ sellEnabled: false })),
  });
  await expectPolicyError(
    sellService.validateTrade(request({ side: TradingSide.SELL })),
    "sell_disabled",
  );
});

test("unknown trading side fails closed", async () => {
  const service = policyService();
  await expectPolicyError(
    service.validateTrade(request({ side: "HOLD" as TradingSide })),
    "invalid_trading_side",
  );
});

test("BUY limits reject outside values and accept exact boundaries", async () => {
  const service = policyService({
    whitelists: new WhitelistLookupStub(activeWhitelist({
      minBuyAmount: decimalString("10.000000000000000001"),
      maxBuyAmount: decimalString("20.000000000000000001"),
    })),
  });

  await expectPolicyError(
    service.validateTrade(request({ amount: "10.000000000000000000" })),
    "amount_below_minimum",
  );
  await expectPolicyError(
    service.validateTrade(request({ amount: "20.000000000000000002" })),
    "amount_above_maximum",
  );
  assert.equal(
    (await service.validateTrade(request({ amount: "10.000000000000000001" }))).amount,
    "10.000000000000000001",
  );
  assert.equal(
    (await service.validateTrade(request({ amount: "20.000000000000000001" }))).amount,
    "20.000000000000000001",
  );
});

test("SELL ignores legacy quantity minimums and still enforces quantity maximums", async () => {
  const service = policyService({
    whitelists: new WhitelistLookupStub(activeWhitelist({
      minSellAmount: decimalString("0.000000001"),
      maxSellAmount: decimalString("0.000000009"),
    })),
  });

  await service.validateTrade(request({ side: TradingSide.SELL, amount: "0.0000000009" }));
  await expectPolicyError(
    service.validateTrade(request({ side: TradingSide.SELL, amount: "0.0000000091" })),
    "amount_above_maximum",
  );
  await service.validateTrade(request({ side: TradingSide.SELL, amount: "0.000000001" }));
  await service.validateTrade(request({ side: TradingSide.SELL, amount: "0.000000009" }));
});

test("zero, negative, and malformed amounts are rejected", async () => {
  const service = policyService();
  for (const amount of ["0", "-0.0001", "", "1.2.3", "NaN"]) {
    await expectPolicyError(service.validateTrade(request({ amount })), "invalid_trade_amount");
  }
});

test("null limits mean no minimum and no maximum", async () => {
  const service = policyService({
    whitelists: new WhitelistLookupStub(activeWhitelist({
      minBuyAmount: null,
      maxBuyAmount: null,
    })),
  });
  const result = await service.validateTrade(request({ amount: "1e-30" }));
  assert.equal(result.amount, "0.000000000000000000000000000001");
});

test("user eligibility denial rejects before wallet eligibility", async () => {
  const userEligibility = new EligibilityStub(false);
  const walletEligibility = new EligibilityStub(true);
  const service = policyService({ userEligibility, walletEligibility });

  await expectPolicyError(service.validateTrade(request()), "user_not_eligible");
  assert.equal(userEligibility.calls.length, 1);
  assert.equal(walletEligibility.calls.length, 0);
});

test("wallet eligibility denial rejects the trade", async () => {
  const walletEligibility = new EligibilityStub(false);
  const service = policyService({ walletEligibility });

  await expectPolicyError(service.validateTrade(request()), "wallet_not_eligible");
  assert.equal(walletEligibility.calls.length, 1);
});

test("valid request invokes both hooks and returns a stable policy snapshot", async () => {
  const userEligibility = new EligibilityStub(true);
  const walletEligibility = new EligibilityStub(true);
  const whitelist = activeWhitelist({ feeBps: 25 });
  const service = policyService({
    whitelists: new WhitelistLookupStub(whitelist),
    userEligibility,
    walletEligibility,
  });

  const result = await service.validateTrade(request({ amount: "15.000" }));

  assert.equal(result.asset, asset);
  assert.equal(result.whitelist, whitelist);
  assert.equal(result.side, TradingSide.BUY);
  assert.equal(result.amount, "15");
  assert.equal(result.feeBps, 25);
  assert.equal(result.validatedAt, validatedAt);
  assert.equal(userEligibility.calls.length, 1);
  assert.equal(walletEligibility.calls.length, 1);
  assert.equal(walletEligibility.calls[0]?.asset.id, asset.id);
});

test("unexpected repository or eligibility failure fails closed without leaking details", async () => {
  const assets: TradingPolicyAssetLookup = {
    findById: async () => { throw new Error("password=secret database unavailable"); },
  };
  const service = policyService({ assets });
  await assert.rejects(
    service.validateTrade(request()),
    (error) => error instanceof TradingPolicyError
      && error.code === "policy_unavailable"
      && !error.message.includes("secret"),
  );
});

test("normal configuration path rejects negative limits, inverted ranges, and negative fees", () => {
  assert.throws(
    () => validateTradingWhitelistConfiguration(configuration({ minBuyAmount: "-0.01" })),
    isPolicyError("invalid_whitelist_configuration"),
  );
  assert.throws(
    () => validateTradingWhitelistConfiguration(configuration({
      minSellAmount: "2.000000000000000001",
      maxSellAmount: "2",
    })),
    isPolicyError("invalid_whitelist_configuration"),
  );
  assert.throws(
    () => validateTradingWhitelistConfiguration(configuration({ feeBps: -1 })),
    isPolicyError("invalid_whitelist_configuration"),
  );
});

test("Postgres repository validates configuration before issuing a database query", async () => {
  let queryCount = 0;
  const pool = {
    query: async () => {
      queryCount += 1;
      throw new Error("query should not run");
    },
  } as unknown as Pool;
  const repository = new PostgresTradingWhitelistRepository(pool);

  await assert.rejects(
    repository.save(configuration({ minBuyAmount: "21", maxBuyAmount: "20" }), validatedAt),
    isPolicyError("invalid_whitelist_configuration"),
  );
  assert.equal(queryCount, 0);
});

test("migration enforces Asset.id foreign key, one row per asset, numeric limits, and integrity checks", async () => {
  const sql = await readFile(resolve(process.cwd(), "migrations/006_trading_whitelist.sql"), "utf8");
  assert.match(sql, /asset_id UUID NOT NULL REFERENCES assets\(id\) ON DELETE RESTRICT/i);
  assert.match(sql, /CONSTRAINT trading_whitelists_asset_unique UNIQUE \(asset_id\)/i);
  assert.match(sql, /min_buy_amount NUMERIC/i);
  assert.match(sql, /max_sell_amount NUMERIC/i);
  assert.match(sql, /fee_bps >= 0/i);
  assert.match(sql, /min_buy_amount <= max_buy_amount/i);
  assert.match(sql, /min_sell_amount <= max_sell_amount/i);
});

test("historical 121-asset activation has no BUY or SELL maximum and enforces BUY strictly above one USDC", async () => {
  const sql = await readFile(
    resolve(process.cwd(), "migrations/042_activate_canonical_trading_catalog.sql"),
    "utf8",
  );
  assert.match(sql, /canonical_count\s*<>\s*121/i);
  assert.match(sql, /status\s*=\s*'ACTIVE'/i);
  assert.match(sql, /buy_enabled\s*=\s*TRUE/i);
  assert.match(sql, /sell_enabled\s*=\s*TRUE/i);
  assert.match(sql, /min_buy_amount\s*=\s*1\.000001/i);
  assert.match(sql, /max_buy_amount\s*=\s*NULL/i);
  assert.match(sql, /min_sell_amount\s*=\s*NULL/i);
  assert.match(sql, /max_sell_amount\s*=\s*NULL/i);
});

test("Whitelist v1 replaces the catalog with exactly 49 active Buy/Sell policies", async () => {
  const sql = await readFile(
    resolve(process.cwd(), "migrations/046_replace_trading_catalog_with_whitelist_v1.sql"),
    "utf8",
  );
  assert.match(sql, /canonical_count\s*<>\s*49/i);
  assert.match(sql, /active_policy_count\s*<>\s*49/i);
  assert.match(sql, /status\s*=\s*'DISABLED'/i);
  assert.match(sql, /buy_enabled\s*=\s*FALSE/i);
  assert.match(sql, /sell_enabled\s*=\s*FALSE/i);
  assert.match(sql, /status\s*=\s*'ACTIVE'/i);
  assert.match(sql, /min_buy_amount\s*=\s*1\.000001/i);
  assert.match(sql, /max_buy_amount\s*=\s*NULL/i);
  assert.match(sql, /min_sell_amount\s*=\s*NULL/i);
  assert.match(sql, /max_sell_amount\s*=\s*NULL/i);
});

function policyService(overrides: {
  readonly assets?: TradingPolicyAssetLookup;
  readonly whitelists?: TradingWhitelistLookup;
  readonly userEligibility?: UserTradingEligibilityService;
  readonly walletEligibility?: WalletTradingEligibilityService;
} = {}): TradingPolicyService {
  return new TradingPolicyService(
    overrides.assets ?? new AssetLookupStub(asset),
    overrides.whitelists ?? new WhitelistLookupStub(activeWhitelist()),
    overrides.userEligibility ?? new EligibilityStub(true),
    overrides.walletEligibility ?? new EligibilityStub(true),
    () => validatedAt,
  );
}

function request(overrides: Partial<Parameters<TradingPolicyService["validateTrade"]>[0]> = {}) {
  return {
    userId: "user-1",
    wallet,
    assetId: asset.id,
    side: TradingSide.BUY,
    amount: "15",
    ...overrides,
  };
}

function activeWhitelist(overrides: Partial<TradingWhitelist> = {}): TradingWhitelist {
  return {
    id: "whitelist-1",
    assetId: asset.id,
    status: TradingWhitelistStatus.ACTIVE,
    buyEnabled: true,
    sellEnabled: true,
    minBuyAmount: decimalString("10"),
    maxBuyAmount: decimalString("20"),
    minSellAmount: decimalString("0.000000001"),
    maxSellAmount: decimalString("100"),
    feeBps: 50,
    enabledAt: validatedAt,
    disabledAt: null,
    createdAt: validatedAt,
    updatedAt: validatedAt,
    ...overrides,
  };
}

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    assetId: asset.id,
    status: TradingWhitelistStatus.ACTIVE,
    buyEnabled: true,
    sellEnabled: true,
    minBuyAmount: "10",
    maxBuyAmount: "20",
    minSellAmount: "1",
    maxSellAmount: "2",
    feeBps: 50,
    enabledAt: validatedAt,
    disabledAt: null,
    ...overrides,
  };
}

async function expectPolicyError(
  promise: Promise<unknown>,
  code: TradingPolicyError["code"],
): Promise<void> {
  await assert.rejects(promise, isPolicyError(code));
}

function isPolicyError(code: TradingPolicyError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof TradingPolicyError && error.code === code;
}

class AssetLookupStub implements TradingPolicyAssetLookup {
  constructor(private readonly asset: Asset | null) {}
  async findById(): Promise<Asset | null> { return this.asset; }
}

class WhitelistLookupStub implements TradingWhitelistLookup {
  calls = 0;
  constructor(private readonly whitelist: TradingWhitelist | null) {}
  async findByAssetId(): Promise<TradingWhitelist | null> {
    this.calls += 1;
    return this.whitelist;
  }
}

class EligibilityStub implements UserTradingEligibilityService, WalletTradingEligibilityService {
  readonly calls: TradingEligibilityContext[] = [];
  constructor(private readonly eligible: boolean) {}
  async checkEligibility(context: TradingEligibilityContext): Promise<TradingEligibilityDecision> {
    this.calls.push(context);
    return { eligible: this.eligible };
  }
}

function sampleAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    ticker: "TSLA",
    xStockSymbol: "TSLAx",
    name: "Tesla",
    logoUrl: null,
    solanaMint: "TeslaMint111",
    decimals: 8,
    sector: null,
    providerAvailable: true,
    providerTradingHalted: false,
    active: true,
    currentPrice: null,
    priceChange: null,
    multiplier: null,
    providerTimestamps: {
      createdAt: null,
      updatedAt: null,
      observedAt: validatedAt,
      priceObservedAt: null,
      multiplierObservedAt: null,
    },
    createdAt: validatedAt,
    updatedAt: validatedAt,
    ...overrides,
  };
}
