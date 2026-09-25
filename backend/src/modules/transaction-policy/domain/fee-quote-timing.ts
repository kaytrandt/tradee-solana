export interface FeeQuoteTiming {
  operation: 'BUY' | 'SELL' | 'WITHDRAW';
  attempts: number;
  providerMs: number;
  composeMs: number;
  simulationMs: number;
  totalMs: number;
  success: boolean;
}
export type FeeTimingObserver = (timing: FeeQuoteTiming) => void;
export function reportFeeTiming(observer: FeeTimingObserver | undefined, timing: FeeQuoteTiming): void {
  // Telemetry must never alter financial behavior. No wallet, amount, transaction
  // bytes, RPC URLs, credentials or provider response is included.
  try { observer?.(timing); } catch { /* observational only */ }
}
