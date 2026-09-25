import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTradeOrderTransition,
  TradeOrderState,
  TradingEngineError,
} from "../src/modules/trading/domain/trading.js";

test("normal Tradee order state machine accepts only explicit forward transitions", () => {
  assert.doesNotThrow(() => assertTradeOrderTransition(TradeOrderState.CREATED, TradeOrderState.QUOTED));
  assert.doesNotThrow(() => assertTradeOrderTransition(TradeOrderState.QUOTED, TradeOrderState.AWAITING_SIGNATURE));
  assert.doesNotThrow(() => assertTradeOrderTransition(TradeOrderState.AWAITING_SIGNATURE, TradeOrderState.SUBMITTED));
  assert.doesNotThrow(() => assertTradeOrderTransition(TradeOrderState.SUBMITTED, TradeOrderState.CONFIRMED));
});

test("CONFIRMED is terminal and arbitrary provider states cannot drive transitions", () => {
  assert.throws(
    () => assertTradeOrderTransition(TradeOrderState.CONFIRMED, TradeOrderState.SUBMITTED),
    isInvalidState,
  );
  assert.throws(
    () => assertTradeOrderTransition(TradeOrderState.AWAITING_SIGNATURE, TradeOrderState.CONFIRMED),
    isInvalidState,
  );
});

function isInvalidState(error: unknown): boolean {
  return error instanceof TradingEngineError && error.code === "TRADE_INVALID_STATE";
}
