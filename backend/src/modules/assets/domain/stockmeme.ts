import type { DecimalString } from "./asset.js";
export interface StockmemeMetadata {
  readonly pairedMint: string;
  readonly pairedSymbol: string;
  readonly pairedName: string;
  readonly pairedLogoUrl: string | null;
  readonly pairedTicker: string;
  readonly description: string;
  readonly launchedAt: string | null;
  readonly marketCapUsd: DecimalString | null;
  readonly volume24hUsd: DecimalString | null;
  readonly holderCount: string | null;
  readonly paidToHoldersTokens: DecimalString | null;
  readonly waitingToDistributeTokens: DecimalString | null;
  readonly burnedAmountRaw?: string | null;
  readonly boughtBackBurnedUsd: DecimalString | null;
  readonly observedAt: string;
  readonly pairedPriceUsd?: DecimalString | null;
  readonly pairedPriceObservedAt?: string | null;
}
export interface StockmemeProvider {
  get(mint: string, pairedTicker: string): Promise<{
    mint: string; name: string; ticker: string; logoUrl: string | null; metadata: StockmemeMetadata;
  }>;
}
