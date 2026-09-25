import { TradingEngineError, type TradeQuote } from '../../domain/trading.js';

// Pinned to the on-chain Anchor IDL at Cp2dCjxCWdktak2JiSrh87X6sz31EnDVKoTGtsHJvhYq
// (DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH), inspected 2026-09-20.
// Sizes exclude the enum tag. All supported swap structs start with amount:u64
// and end with flags:u8. New action schemas must be reviewed, never guessed.
const sizes: Readonly<Record<number, number>> = {
  0:10,1:10,2:9,3:9,4:10,5:10,6:10,7:10,8:9,9:9,10:10,11:9,12:9,13:9,14:9,15:9,
  16:9,17:9,18:9,19:9,20:9,21:9,22:10,23:17,24:10,25:10,26:9,27:9,28:9,29:9,30:9,
  32:9,33:9,34:9,39:9,40:9,41:19,42:14,44:25,46:9,47:9,53:9,54:9,55:9,56:9,
  58:9,59:9,62:9,65:9,66:9,67:9,68:9,69:10,70:9,71:9,72:13,73:13,74:9,75:82,76:10,
};

/** Parse the entire Borsh payload before reading constraints; reading a footer
 * alone is unsafe because an attacker could append a second, benign footer. */
export function validateDflowSwapConstraints(data: Buffer, quote: TradeQuote): void {
  let offset = 0;
  const take = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > data.length) throw invalid();
    const result = data.subarray(offset, offset + count); offset += count; return result;
  };
  if (!take(8).equals(Buffer.from([248,198,158,145,225,117,135,200]))) throw invalid();
  const count = take(4).readUInt32LE();
  if (count < 1 || count > 64) throw invalid();
  let firstAmount: bigint | undefined;
  for (let index = 0; index < count; index++) {
    const tag = take(1)[0]!;
    if (tag === 37 || tag === 38) { take(tag === 37 ? 76 : 4); continue; }
    if (tag === 45 || tag === 50 || tag === 60) continue;
    if (tag === 48 || tag === 49) {
      const length = take(4).readUInt32LE(); if (length > 64) throw invalid();
      take(length * (tag === 48 ? 8 : 9)); continue;
    }
    let size = sizes[tag];
    if (tag === 31) {
      const candidates = take(4).readUInt32LE();
      if (candidates < 1 || candidates > 13) throw invalid();
      for (let candidate = 0; candidate < candidates; candidate++) {
        const kind = take(1)[0]!; if (kind > 12) throw invalid();
        take(kind === 3 ? 8 : kind === 10 || kind === 12 ? 1 : 0);
      }
      size = 9;
    }
    // Fee actions, native SOL actions and unreviewed variable schemas fail closed.
    if (size === undefined) throw invalid();
    const action = take(size);
    firstAmount ??= action.readBigUInt64LE();
  }
  const expectedOutput = take(8).readBigUInt64LE();
  const slippage = take(2).readUInt16LE(), platformFee = take(2).readUInt16LE();
  const fee = quote.side === 'SELL' ? BigInt(quote.tradeeFee) : 0n;
  const minOutput = expectedOutput - expectedOutput * BigInt(slippage) / 10_000n;
  if (offset !== data.length || platformFee !== 0 || slippage !== quote.slippageBps || slippage > 10_000
    || firstAmount !== BigInt(quote.economicTradingAmount)
    || expectedOutput !== BigInt(quote.expectedOutputAmount) + fee
    || minOutput < BigInt(quote.minimumOutputAmount) + fee) throw invalid();
}
function invalid() { return new TradingEngineError('TRADE_TRANSACTION_MISMATCH', 'The router constraints do not match the reviewed trade.'); }
