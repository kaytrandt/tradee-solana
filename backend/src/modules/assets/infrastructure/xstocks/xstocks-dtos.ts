// These DTOs mirror only verified fields from the xStocks v2 OpenAPI document.
// They are intentionally private to the xStocks adapter directory.
export interface XStocksListResponseDTO {
  readonly nodes: readonly XStocksAssetDTO[];
  readonly page: {
    readonly currentPage: number;
    readonly hasNextPage: boolean;
  };
}

export interface XStocksAssetDTO {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly underlyingSymbol?: string;
  readonly underlying?: {
    readonly symbol: string;
    readonly isin: string | null;
    readonly type: "Equity" | "ETF" | null;
    readonly listingCountry: string | null;
  } | null;
  readonly logo?: string;
  readonly isTradingHalted: boolean;
  readonly trading?: {
    readonly currency: string;
    readonly isTradingHalted: boolean;
    readonly openNow: boolean;
  } | null;
  readonly deployments: readonly XStocksDeploymentDTO[];
}

export interface XStocksDeploymentDTO {
  readonly address: string;
  readonly network: string;
  readonly supportsAtomicSwaps: boolean;
}

export function decodeXStocksListResponse(value: unknown): XStocksListResponseDTO {
  if (!isObject(value) || !Array.isArray(value.nodes) || !isObject(value.page)) {
    throw new Error("Invalid xStocks asset list response");
  }

  const currentPage = value.page.currentPage;
  const hasNextPage = value.page.hasNextPage;
  if (typeof currentPage !== "number" || typeof hasNextPage !== "boolean") {
    throw new Error("Invalid xStocks asset pagination response");
  }

  return {
    nodes: value.nodes.map(decodeXStocksAsset),
    page: { currentPage, hasNextPage },
  };
}

function decodeXStocksAsset(value: unknown): XStocksAssetDTO {
  if (!isObject(value)) {
    throw new Error("Invalid xStocks asset record");
  }
  const id = requiredString(value, "id");
  const name = requiredString(value, "name");
  const symbol = requiredString(value, "symbol");
  const isTradingHalted = requiredBoolean(value, "isTradingHalted");

  if (!Array.isArray(value.deployments)) {
    throw new Error(`xStocks asset ${symbol} is missing deployments`);
  }

  const underlying = value.underlying;
  return {
    id,
    name,
    symbol,
    isTradingHalted,
    deployments: value.deployments.map(decodeDeployment),
    ...(typeof value.logo === "string" ? { logo: value.logo } : {}),
    ...(typeof value.underlyingSymbol === "string" ? { underlyingSymbol: value.underlyingSymbol } : {}),
    ...(underlying === null
      ? { underlying: null }
      : isObject(underlying)
        ? {
            underlying: {
              symbol: requiredString(underlying, "symbol"),
              isin: nullableString(underlying.isin),
              type:
                underlying.type === "Equity" || underlying.type === "ETF"
                  ? underlying.type
                  : null,
              listingCountry: nullableString(underlying.listingCountry),
            },
          }
        : {}),
    ...(value.trading === null
      ? { trading: null }
      : isObject(value.trading)
        ? {
            trading: {
              currency: requiredString(value.trading, "currency"),
              isTradingHalted: requiredBoolean(value.trading, "isTradingHalted"),
              openNow: requiredBoolean(value.trading, "openNow"),
            },
          }
        : {}),
  };
}

function decodeDeployment(value: unknown): XStocksDeploymentDTO {
  if (!isObject(value)) {
    throw new Error("Invalid xStocks deployment record");
  }
  return {
    address: requiredString(value, "address"),
    network: requiredString(value, "network"),
    supportsAtomicSwaps: requiredBoolean(value, "supportsAtomicSwaps"),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Expected non-empty string field ${key}`);
  }
  return field;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`Expected boolean field ${key}`);
  }
  return field;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
