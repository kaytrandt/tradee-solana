import assert from "node:assert/strict";
import test from "node:test";
import { FeeEngine } from "../src/modules/trading/application/fee-engine.js";
import { baseUnitAmount } from "../src/modules/trading/domain/base-units.js";
import { TradingEngineError } from "../src/modules/trading/domain/trading.js";

const fees = new FeeEngine();

test("BUY 100 USDC at 50 bps preserves gross debit and derives 99.50 economic trading value", () => {
  const result = fees.buyEconomics(baseUnitAmount("100000000"), 50);
  assert.equal(result.grossInput, "100000000");
  assert.equal(result.tradeeFee, "500000");
  assert.equal(result.economicTradingAmount, "99500000");
});

test("SELL fee economics deduct fee from gross USDC output", () => {
  const result = fees.sellEconomics(baseUnitAmount("99500000"), baseUnitAmount("500000"));
  assert.equal(result.grossOutput, "100000000");
  assert.equal(result.tradeeFee, "500000");
  assert.equal(result.netOutput, "99500000");
});

test("FeeEngine uses deterministic base-unit floor rounding", () => {
  assert.equal(fees.calculateFee(baseUnitAmount("101"), 50), "0");
  assert.equal(fees.calculateFee(baseUnitAmount("200"), 50), "1");
});

test("Solana tiered fee policy is continuous at every configured boundary", () => {
  const cases = [
    ["1000000", "100000", 1_000],
    ["4999999", "100000", 200],
    ["5000000", "100000", 200],
    ["10000000", "200000", 200],
    ["47500000", "950000", 200],
    ["100000000", "950000", 95],
    ["190000000", "950000", 50],
    ["200000000", "1000000", 50],
  ] as const;

  for (const [amount, targetFee, effectiveFeeBps] of cases) {
    const result = fees.solanaTieredFee(baseUnitAmount(amount), 6);
    assert.equal(result.targetFee, targetFee);
    assert.equal(result.effectiveFeeBps, effectiveFeeBps);
  }
});

test("provider fee mismatch fails closed", () => {
  assert.throws(
    () => fees.verifyProviderFee({
      provider: "DFLOW" as never,
      inputMint: "USDC",
      outputMint: "TSLA",
      inputAmount: baseUnitAmount("100000000"),
      outputAmount: baseUnitAmount("1000"),
      minimumOutputAmount: baseUnitAmount("900"),
      platformFeeAmount: baseUnitAmount("499999"),
      platformFeeBps: 50,
      platformFeeMode: "inputMint",
      slippageBps: 50,
      priceImpact: "0.01" as never,
      lastValidBlockHeight: 100n,
      providerReference: null,
      executionMode: "sync",
      route: [],
      transaction: "AA==",
    }, 50, "inputMint"),
    (error) => error instanceof TradingEngineError && error.code === "TRADE_FEE_MISMATCH",
  );
});
