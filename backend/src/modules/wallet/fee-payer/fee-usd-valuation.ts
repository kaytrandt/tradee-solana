import { baseUnitsToExact, multiplyExact } from "../../accounting/domain/exact-amount.js";

export const MAX_FEE_PRICE_AGE_MS = 120_000;
export interface NativeFeePrice {
  readonly source: "JUPITER_PRICE_V3";
  readonly mint: string;
  readonly usdPerSol: string;
  readonly blockId: string;
  readonly blockTime: string;
  readonly fetchedAt: string;
}
export type NativeFeePriceResult =
  | { readonly status: "AVAILABLE"; readonly price: NativeFeePrice }
  | { readonly status: "UNAVAILABLE" | "STALE" | "UNCONFIGURED"; readonly price: null };
export interface NativeFeePriceSource { getPrice(): Promise<NativeFeePriceResult> }
export interface FeeUsdValuation {
  readonly status: NativeFeePriceResult["status"];
  readonly price: NativeFeePrice | null;
  readonly valuedAt: string;
  readonly estimatedNetworkFeeLamports: string;
  readonly estimatedPayerDebitLamports: string;
  readonly estimatedNetworkFeeUsd: string | null;
  readonly estimatedPayerDebitUsd: string | null;
}
export function priceIsFresh(price: NativeFeePrice, now: number): boolean {
  const age = now - Date.parse(price.blockTime);
  return Number.isFinite(age) && age >= 0 && age <= MAX_FEE_PRICE_AGE_MS;
}
/** USD is indicative reporting, never a replacement for lamport policy enforcement.
 * Exact product, without cent rounding: a tiny non-zero fee must not become $0. */
export function valueNativeFee(result: NativeFeePriceResult, fee: bigint, debit: bigint, now = Date.now()): FeeUsdValuation {
  if (fee < 0n || debit < 0n) throw new Error("Invalid estimated native fee.");
  const status = result.status === "AVAILABLE" && !priceIsFresh(result.price, now) ? "STALE" : result.status;
  const price = result.status === "AVAILABLE" && status === "AVAILABLE" ? result.price : null;
  return { status, price, valuedAt: new Date(now).toISOString(), estimatedNetworkFeeLamports: fee.toString(),
    estimatedPayerDebitLamports: debit.toString(),
    estimatedNetworkFeeUsd: price ? multiplyExact(baseUnitsToExact(fee.toString(), 9), price.usdPerSol) : null,
    estimatedPayerDebitUsd: price ? multiplyExact(baseUnitsToExact(debit.toString(), 9), price.usdPerSol) : null };
}
