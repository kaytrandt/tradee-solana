import type {
  AssetCorporateActionSyncRecord,
  DecimalString,
} from "../../domain/asset.js";
import type {
  SolanaMintMetadataReader,
  XStocksProvider,
  XStocksProviderAsset,
} from "../../domain/xstocks-provider.js";
import { extractNullableDecimalField } from "./exact-json-decimal.js";
import { decodeXStocksListResponse, type XStocksAssetDTO } from "./xstocks-dtos.js";
import { asRecord, optionalExactDecimal, parseExactJson } from "../../../provider-platform/infrastructure/exact-json.js";

export interface XStocksHttpProviderOptions {
  readonly baseUrl?: string;
  readonly pageSize?: number;
  readonly enrichmentConcurrency?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
}

const XSTOCKS_TOKEN_LOGO_BASE_URL = "https://xstocks-metadata.backed.fi/logos/tokens";

export function xStocksTokenLogoUrl(xStockSymbol: string): string {
  const symbol = xStockSymbol.trim();
  if (symbol.length === 0 || !symbol.toLowerCase().endsWith("x")) {
    throw new Error(`Invalid xStocks symbol for logo: ${xStockSymbol}`);
  }
  return `${XSTOCKS_TOKEN_LOGO_BASE_URL}/${encodeURIComponent(symbol)}.png`;
}

export class XStocksHttpProvider implements XStocksProvider {
  readonly name = "xstocks" as const;

  readonly #baseUrl: string;
  readonly #pageSize: number;
  readonly #enrichmentConcurrency: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;

  constructor(
    private readonly mintMetadataReader: SolanaMintMetadataReader,
    options: XStocksHttpProviderOptions = {},
  ) {
    this.#baseUrl = (options.baseUrl ?? "https://api.xstocks.fi/api/v2").replace(/\/$/, "");
    this.#pageSize = options.pageSize ?? 100;
    this.#enrichmentConcurrency = options.enrichmentConcurrency ?? 5;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async listSolanaAssets(): Promise<readonly XStocksProviderAsset[]> {
    const snapshotObservedAt = this.#now();
    const assets = await this.#listEveryPage();
    const withSolana = assets.flatMap((asset) => {
      const deployment = asset.deployments.find((item) => item.network === "Solana");
      return deployment ? [{ asset, solanaMint: deployment.address }] : [];
    });

    return mapWithConcurrency(withSolana, this.#enrichmentConcurrency, async ({ asset, solanaMint }) => {
      const [decimals, multiplierState, corporateActions] = await Promise.all([
        this.mintMetadataReader.getDecimals(solanaMint),
        this.#fetchMultiplierState(asset.symbol),
        this.#fetchCorporateActions(asset.symbol),
      ]);
      const deployment = asset.deployments.find((item) => item.network === "Solana");
      if (deployment === undefined) throw new Error(`Missing Solana deployment for ${asset.symbol}.`);

      return {
        providerAssetId: asset.id,
        ticker: asset.underlying?.symbol || asset.underlyingSymbol || asset.symbol.replace(/x$/, ""),
        xStockSymbol: asset.symbol,
        name: asset.name,
        logoUrl: asset.logo ?? null,
        solanaMint,
        decimals,
        // Provider state is retained for policy/admin consumers. It is not Tradee
        // trading authorization; TradingPolicyService remains authoritative.
        available: true,
        tradingHalted: asset.isTradingHalted || (asset.trading?.isTradingHalted ?? false),
        marketOpen: asset.trading?.openNow ?? null,
        supportsAtomicSwaps: deployment.supportsAtomicSwaps,
        currentPrice: null,
        priceCurrency: asset.trading?.currency ?? null,
        // The verified xStocks asset API exposes only a latest quote, not historical change.
        priceChangeAbsolute: null,
        priceChangePercent: null,
        priceChangePeriod: null,
        multiplier: multiplierState?.currentMultiplier ?? null,
        pendingMultiplier: multiplierState?.pendingMultiplier ?? null,
        pendingMultiplierActivationAt: multiplierState?.activationAt ?? null,
        pendingMultiplierReason: multiplierState?.reason ?? null,
        corporateActions,
        providerCreatedAt: null,
        providerUpdatedAt: null,
        observedAt: snapshotObservedAt,
        priceObservedAt: null,
        multiplierObservedAt: multiplierState?.observedAt ?? null,
      } satisfies XStocksProviderAsset;
    });
  }

  async #listEveryPage(): Promise<readonly XStocksAssetDTO[]> {
    const assets: XStocksAssetDTO[] = [];
    let page = 0;

    for (;;) {
      const url = new URL(`${this.#baseUrl}/public/assets`);
      url.searchParams.set("network", "Solana");
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(this.#pageSize));

      const response = await this.#fetch(url, { signal: AbortSignal.timeout(this.#requestTimeoutMs) });
      if (!response.ok) {
        throw new Error(`xStocks asset list failed with HTTP ${response.status}`);
      }
      const payload = decodeXStocksListResponse(await response.json());
      assets.push(...payload.nodes);

      if (!payload.page.hasNextPage) {
        return assets;
      }
      page = payload.page.currentPage + 1;
    }
  }

  async #fetchMultiplierState(symbol: string): Promise<{
    readonly currentMultiplier: DecimalString;
    readonly pendingMultiplier: DecimalString | null;
    readonly activationAt: Date | null;
    readonly reason: string | null;
    readonly observedAt: Date;
  } | null> {
    try {
      const response = await this.#fetch(
        `${this.#baseUrl}/public/assets/${encodeURIComponent(symbol)}/multiplier?network=Solana`,
        { signal: AbortSignal.timeout(this.#requestTimeoutMs) },
      );
      if (!response.ok) return null;
      const text = await response.text();
      const currentMultiplier = extractNullableDecimalField(text, "currentMultiplier");
      if (currentMultiplier === null) return null;
      const root = asRecord(parseExactJson(text));
      if (root === null) return null;
      const candidate = optionalExactDecimal(root.newMultiplier);
      const activationAt = activationDate(root.activationDateTime);
      return {
        currentMultiplier,
        pendingMultiplier: candidate === null || candidate === "0" || activationAt === null ? null : candidate,
        activationAt,
        reason: typeof root.reason === "string" && root.reason.length > 0 ? root.reason : null,
        observedAt: this.#now(),
      };
    } catch {
      return null;
    }
  }

  async #fetchCorporateActions(symbol: string): Promise<readonly AssetCorporateActionSyncRecord[]> {
    try {
      const actions: AssetCorporateActionSyncRecord[] = [];
      let page = 0;
      for (;;) {
        const response = await this.#fetch(
          `${this.#baseUrl}/public/assets/${encodeURIComponent(symbol)}/multiplier/history?network=Solana&page=${page}&pageSize=100`,
          { signal: AbortSignal.timeout(this.#requestTimeoutMs) },
        );
        if (!response.ok) return actions;
        const root = asRecord(parseExactJson(await response.text()));
        if (root === null || !Array.isArray(root.nodes)) return actions;
        actions.push(...root.nodes.flatMap((value) => {
          const event = asRecord(value);
          const providerEventId = typeof event?.id === "string" ? event.id : null;
          const reason = typeof event?.reason === "string" ? event.reason : null;
          const multiplier = optionalExactDecimal(event?.multiplier);
          const previousMultiplier = optionalExactDecimal(event?.previousMultiplier);
          const activatesAt = activationDate(event?.activationDateTime);
          return providerEventId === null || reason === null || multiplier === null || previousMultiplier === null || activatesAt === null
            ? []
            : [{ providerEventId, reason, multiplier, previousMultiplier, activatesAt }];
        }));
        const pagination = asRecord(root.page);
        if (pagination?.hasNextPage !== true) return actions;
        const currentPage = typeof pagination.currentPage === "string" && /^\d+$/.test(pagination.currentPage)
          ? Number.parseInt(pagination.currentPage, 10)
          : page;
        const nextPage = currentPage + 1;
        if (!Number.isSafeInteger(nextPage) || nextPage <= page || nextPage > 10_000) return actions;
        page = nextPage;
      }
    } catch {
      return [];
    }
  }
}

function activationDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "0") return null;
  const milliseconds = /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
  const date = milliseconds === null ? new Date(value) : new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  transform: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("enrichmentConcurrency must be a positive integer");
  }

  const output = new Array<Output>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await transform(value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return output;
}
