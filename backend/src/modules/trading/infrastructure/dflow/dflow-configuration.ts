export type DFlowEnvironment = "development" | "production";

export interface DFlowClientConfiguration {
  readonly environment: DFlowEnvironment;
  readonly tradeApiUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
}

export interface DFlowProviderConfiguration {
  readonly feeAccountUsdc: string;
  readonly sponsor?: string;
  readonly priorityLamports?: string;
}

const DEVELOPMENT_URL = "https://dev-quote-api.dflow.net";
const PRODUCTION_URL = "https://quote-api.dflow.net";

export function dflowClientConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): DFlowClientConfiguration {
  const mode = parseEnvironment(environment.DFLOW_ENV);
  const apiKey = trimmed(environment.DFLOW_API_KEY);
  if (mode === "production" && apiKey === undefined) {
    throw new Error("DFLOW_API_KEY is required when DFLOW_ENV=production.");
  }

  const configuredUrl = trimmed(environment.DFLOW_TRADE_API_URL);
  const tradeApiUrl = validateBaseUrl(configuredUrl ?? (
    mode === "production" ? PRODUCTION_URL : DEVELOPMENT_URL
  ));
  if (mode === "production" && tradeApiUrl !== PRODUCTION_URL && configuredUrl === undefined) {
    throw new Error("Production DFlow configuration cannot use the developer endpoint.");
  }
  if (mode === "production" && tradeApiUrl === DEVELOPMENT_URL) {
    throw new Error("DFLOW_ENV=production cannot use the DFlow developer endpoint.");
  }

  return {
    environment: mode,
    tradeApiUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    timeoutMs: positiveInteger(environment.DFLOW_TIMEOUT_MS, 8_000, "DFLOW_TIMEOUT_MS"),
  };
}

export function dflowProviderConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): DFlowProviderConfiguration {
  return {
    feeAccountUsdc: required(environment, "DFLOW_PLATFORM_FEE_ACCOUNT_USDC"),
  };
}

function parseEnvironment(value: string | undefined): DFlowEnvironment {
  const normalized = value?.trim().toLowerCase() ?? "development";
  if (normalized === "development" || normalized === "production") return normalized;
  throw new Error("DFLOW_ENV must be development or production.");
}

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("DFLOW_TRADE_API_URL must be an HTTPS URL without credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("DFLOW_TRADE_API_URL must not contain query parameters or fragments.");
  }
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = trimmed(environment[name]);
  if (value === undefined) throw new Error(`${name} is required for DFlow trading.`);
  return value;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}
