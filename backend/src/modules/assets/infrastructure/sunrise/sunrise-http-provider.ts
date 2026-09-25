import type { AssetProvider, AssetProviderAsset } from "../../domain/asset-provider.js";
import { SUNRISE_ASSET_CATALOG } from "../../domain/sunrise-asset-catalog.js";
import type { SolanaMintMetadataReader } from "../../domain/xstocks-provider.js";

export interface SunriseHttpProviderOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly now?: () => Date;
}

/** Sunrise transport stays here; only the explicitly approved Solana mints enter the domain. */
export class SunriseHttpProvider implements AssetProvider {
  readonly name = "sunrise";
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly mintReader: SolanaMintMetadataReader, options: SunriseHttpProviderOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.sunrise.xyz").replace(/\/$/, "");
    this.now = options.now ?? (() => new Date());
  }

  async listSolanaAssets(): Promise<readonly AssetProviderAsset[]> {
    const tokens: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    const observedAt = this.now();
    do {
      const url = new URL(`${this.baseUrl}/v1/tokens`);
      url.searchParams.set("limit", "200");
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const response = await this.request(url, { headers: { accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Sunrise token list failed with HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!object(payload) || payload.success !== true || !object(payload.data) ||
          !Array.isArray(payload.data.tokens) || payload.data.count !== payload.data.tokens.length ||
          !payload.data.tokens.every(object)) throw new Error("Invalid Sunrise token list");
      tokens.push(...payload.data.tokens);
      const pagination = payload.data.pagination;
      if (pagination !== undefined && (!object(pagination) ||
          (pagination.nextCursor !== null && (typeof pagination.nextCursor !== "string" ||
            !/^[A-Za-z0-9_-]{1,2048}$/.test(pagination.nextCursor))))) {
        throw new Error("Invalid Sunrise pagination");
      }
      cursor = object(pagination) && typeof pagination.nextCursor === "string" ? pagination.nextCursor : null;
      if (cursor !== null) {
        if (cursors.has(cursor) || cursors.size >= 100) throw new Error("Repeated or excessive Sunrise pagination");
        cursors.add(cursor);
      }
    } while (cursor !== null);

    const assets: AssetProviderAsset[] = [];
    for (const approved of SUNRISE_ASSET_CATALOG) {
      const matches = tokens.filter((token) => token.address === approved.solanaMint || token.symbol === approved.ticker);
      if (matches.length === 0) continue; // Repository marks a missing mint unavailable; configure refuses an incomplete catalog.
      if (matches.length !== 1) throw new Error(`Duplicate Sunrise identity: ${approved.ticker}`);
      const token = matches[0]!;
      if (token.address !== approved.solanaMint || token.symbol !== approved.ticker ||
          token.chain !== "solana" || token.assetClass !== "stock" || token.platform !== "svm" ||
          token.tokenProgram !== "token-2022" ||
          // Some approved tokens have no company metadata yet. Mint + symbol remain mandatory;
          // when company metadata exists its ticker must agree with the approved identity.
          (token.stock != null && (!object(token.stock) || token.stock.ticker !== approved.ticker)) ||
          !Number.isInteger(token.decimals) || Number(token.decimals) < 0 || Number(token.decimals) > 255) {
        throw new Error(`Sunrise identity mismatch: ${approved.ticker}`);
      }
      if (!this.mintReader.getScaledUiMetadata) throw new Error('Sunrise requires onchain scaled UI metadata');
      const metadata = await this.mintReader.getScaledUiMetadata(approved.solanaMint);
      const { decimals } = metadata;
      if (decimals !== token.decimals) throw new Error(`Sunrise onchain decimals mismatch: ${approved.ticker}`);
      const pending = metadata.activatesAt > observedAt;
      let logoUrl: string | null = null;
      if (typeof token.icon === "string") {
        const logo = new URL(token.icon);
        if (logo.protocol !== "https:" || logo.username || logo.password) throw new Error("Invalid Sunrise logo URL");
        logoUrl = logo.href;
      }
      assets.push({
        providerAssetId: approved.solanaMint, ticker: approved.ticker, xStockSymbol: approved.ticker,
        name: approved.name, logoUrl, solanaMint: approved.solanaMint, decimals,
        available: true, tradingHalted: metadata.paused, marketOpen: null, supportsAtomicSwaps: false,
        // Prices remain in raw token units. Quantity scaling comes only from the mint.
        currentPrice: null, priceCurrency: null, priceChangeAbsolute: null, priceChangePercent: null,
        priceChangePeriod: null, multiplier: pending ? metadata.multiplier : metadata.pendingMultiplier,
        pendingMultiplier: pending ? metadata.pendingMultiplier : null,
        pendingMultiplierActivationAt: pending ? metadata.activatesAt : null,
        pendingMultiplierReason: pending ? 'Token-2022 scaled UI amount' : null, corporateActions: [],
        providerCreatedAt: null, providerUpdatedAt: null, observedAt, priceObservedAt: null,
        multiplierObservedAt: observedAt,
      });
    }
    return assets;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
