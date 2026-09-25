import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { decimalString } from "../../../assets/domain/asset.js";
import { parseExactDecimal } from "../../../transaction-policy/domain/exact-decimal.js";
import {
  baseUnitAmount,
  positiveBaseUnitAmount,
} from "../../domain/base-units.js";
import {
  TradingEngineError,
  TradingProviderName,
  type PlatformFeeMode,
  type ProviderOrderRequest,
  type ProviderPreparedOrder,
  type TradeRouteLeg,
  type TradingProvider,
} from "../../domain/trading.js";
import type { DFlowProviderConfiguration } from "./dflow-configuration.js";
import { DFlowClient } from "./dflow-client.js";

interface DFlowPlatformFee {
  readonly amount: string;
  readonly feeBps: number;
  readonly mode: PlatformFeeMode;
}

interface DFlowRouteLeg {
  readonly venue: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: string;
  readonly outAmount: string;
}

interface DFlowOrderResponse {
  readonly contextSlot: number;
  readonly executionMode: string;
  readonly inAmount: string;
  readonly inputMint: string;
  readonly minOutAmount: string;
  readonly otherAmountThreshold: string;
  readonly outAmount: string;
  readonly outputMint: string;
  readonly priceImpactPct: string;
  readonly slippageBps: number;
  readonly lastValidBlockHeight: number;
  readonly platformFee: DFlowPlatformFee | null;
  readonly routePlan: readonly DFlowRouteLeg[];
  readonly transaction: string;
}

export class DFlowTradingProvider implements TradingProvider {
  readonly name = TradingProviderName.DFLOW;

  constructor(
    private readonly client: DFlowClient,
    private readonly configuration: DFlowProviderConfiguration,
  ) {}

  async createOrder(request: ProviderOrderRequest): Promise<ProviderPreparedOrder> {
    if (request.feeAccount !== this.configuration.feeAccountUsdc) {
      throw invalidRoute("Tradee fee account configuration does not match the order.");
    }
    const response = parseOrderResponse(await this.client.getOrder({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
      slippageBps: request.slippageBps.toString(),
      userPublicKey: request.userPublicKey,
      platformFeeBps: request.platformFeeBps.toString(),
      platformFeeMode: request.platformFeeMode,
      ...(request.platformFeeBps === 0 ? {} : { feeAccount: request.feeAccount }),
      // Privy replaces the Solana fee payer when it sponsors network fees.
      // DFlow must prepare the route as sponsored as well, especially for
      // Token-2022 assets whose transfer-fee accounting changes on this path.
      sponsoredSwap: "true",
      // The Tradee user's embedded wallet remains the swap executor. Privy is
      // only the fee payer; it must not become the DFlow execution authority.
      sponsorExec: "false",
      ...(this.configuration.sponsor === undefined ? {} : {
        sponsor: this.configuration.sponsor,
        prioritizationFeeLamports: this.configuration.priorityLamports ?? "100000",
        allowSyncExec: "true", allowAsyncExec: "false",
        transactionVersion: "v0",
      }),
    }), request.platformFeeMode);

    if (
      response.inputMint !== request.inputMint
      || response.outputMint !== request.outputMint
      || response.inAmount !== request.amount
      || response.slippageBps !== request.slippageBps
    ) {
      throw invalidRoute("DFlow returned an order that does not match the Tradee request.");
    }
    if (response.executionMode !== "sync") {
      throw invalidRoute("Asynchronous execution is not supported for Tradee spot orders.");
    }

    if (this.configuration.sponsor) {
      try {
        const tx = VersionedTransaction.deserialize(Buffer.from(response.transaction, "base64"));
        if (tx.message.header.numRequiredSignatures !== 2
          || tx.message.staticAccountKeys[0]?.toBase58() !== this.configuration.sponsor
          || tx.message.staticAccountKeys[1]?.toBase58() !== request.userPublicKey
          || tx.signatures.some(s => s.some(b => b !== 0))) throw new Error();
      } catch { throw invalidRoute("DFlow did not return the approved user and gas-payer signer pair."); }
    }

    return {
      provider: this.name,
      ...(this.configuration.sponsor ? { requiredSigners: [this.configuration.sponsor, request.userPublicKey] } : {}),
      inputMint: response.inputMint,
      outputMint: response.outputMint,
      inputAmount: positiveBaseUnitAmount(response.inAmount),
      outputAmount: positiveBaseUnitAmount(response.outAmount),
      minimumOutputAmount: positiveBaseUnitAmount(response.otherAmountThreshold),
      platformFeeAmount: baseUnitAmount(response.platformFee?.amount ?? "0"),
      platformFeeBps: response.platformFee?.feeBps ?? 0,
      platformFeeMode: response.platformFee?.mode ?? request.platformFeeMode,
      slippageBps: response.slippageBps,
      priceImpact: dflowPriceImpactPercentagePoints(response.priceImpactPct),
      lastValidBlockHeight: BigInt(response.lastValidBlockHeight),
      providerReference: `dflow-tx:${createHash("sha256").update(response.transaction).digest("hex")}`,
      executionMode: "sync",
      route: response.routePlan.map(mapRouteLeg),
      transaction: response.transaction,
    };
  }
}

function dflowPriceImpactPercentagePoints(value: string) {
  const ratio = parseExactDecimal(value);
  if (ratio.coefficient < 0n) {
    throw invalidRoute("DFlow returned a negative price impact.");
  }
  // DFlow defines priceImpactPct as a ratio: 0.01 means 1%. Tradee stores
  // percentage points so the client can render the exact value with a `%`.
  return decimalString(parseExactDecimal(`${ratio.value}e2`).value);
}

function parseOrderResponse(value: unknown, requestedFeeMode: PlatformFeeMode): DFlowOrderResponse {
  const object = record(value, "DFlow order response");
  const platformFeeValue = object.platformFee;
  const response: DFlowOrderResponse = {
    contextSlot: safeInteger(object.contextSlot, "contextSlot"),
    executionMode: string(object.executionMode, "executionMode"),
    inAmount: unsignedIntegerString(object.inAmount, "inAmount"),
    inputMint: string(object.inputMint, "inputMint"),
    minOutAmount: unsignedIntegerString(object.minOutAmount, "minOutAmount"),
    otherAmountThreshold: unsignedIntegerString(object.otherAmountThreshold, "otherAmountThreshold"),
    outAmount: unsignedIntegerString(object.outAmount, "outAmount"),
    outputMint: string(object.outputMint, "outputMint"),
    priceImpactPct: string(object.priceImpactPct, "priceImpactPct"),
    slippageBps: safeInteger(object.slippageBps, "slippageBps"),
    lastValidBlockHeight: safeInteger(object.lastValidBlockHeight, "lastValidBlockHeight"),
    platformFee: platformFeeValue === null || platformFeeValue === undefined
      ? null
      : parsePlatformFee(platformFeeValue, requestedFeeMode),
    routePlan: array(object.routePlan, "routePlan").map(parseRouteLeg),
    transaction: base64String(object.transaction, "transaction"),
  };
  if (response.minOutAmount !== response.otherAmountThreshold) {
    throw invalidRoute("DFlow minimum output fields disagree.");
  }
  return response;
}

function parsePlatformFee(value: unknown, requestedMode: PlatformFeeMode): DFlowPlatformFee {
  const object = record(value, "platformFee");
  const mode = string(object.mode, "platformFee.mode");
  if (mode !== "inputMint" && mode !== "outputMint") {
    throw invalidRoute("DFlow returned an invalid platform fee mode.");
  }
  if (mode !== requestedMode) {
    throw invalidRoute("DFlow returned an unexpected platform fee mode.");
  }
  return {
    amount: unsignedIntegerString(object.amount, "platformFee.amount"),
    feeBps: safeInteger(object.feeBps, "platformFee.feeBps"),
    mode,
  };
}

function parseRouteLeg(value: unknown): DFlowRouteLeg {
  const object = record(value, "routePlan leg");
  return {
    venue: string(object.venue, "routePlan.venue"),
    inputMint: string(object.inputMint, "routePlan.inputMint"),
    outputMint: string(object.outputMint, "routePlan.outputMint"),
    inAmount: unsignedIntegerString(object.inAmount, "routePlan.inAmount"),
    outAmount: unsignedIntegerString(object.outAmount, "routePlan.outAmount"),
  };
}

function mapRouteLeg(leg: DFlowRouteLeg): TradeRouteLeg {
  return {
    venue: leg.venue,
    inputMint: leg.inputMint,
    outputMint: leg.outputMint,
    inputAmount: baseUnitAmount(leg.inAmount),
    outputAmount: baseUnitAmount(leg.outAmount),
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRoute(`${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidRoute(`${name} is invalid.`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidRoute(`${name} is invalid.`);
  return value;
}

function unsignedIntegerString(value: unknown, name: string): string {
  const result = string(value, name);
  if (!/^\d+$/.test(result)) throw invalidRoute(`${name} is invalid.`);
  return result;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRoute(`${name} is invalid.`);
  }
  return value;
}

function base64String(value: unknown, name: string): string {
  const result = string(value, name);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result) || Buffer.from(result, "base64").length === 0) {
    throw invalidRoute(`${name} is invalid.`);
  }
  return result;
}

function invalidRoute(message: string): TradingEngineError {
  return new TradingEngineError("TRADE_INVALID_ROUTE", message);
}
