import { baseUnitsToExact, rawQuantityTimesMultiplier } from "../../accounting/domain/exact-amount.js";
import { isBuyDebitWithinBudget } from "../domain/buy-input-budget.js";

export interface ConfirmedReceiptRequest {
  readonly executionId: string;
  readonly userId: string;
  readonly signature: string;
  readonly walletAddress: string;
  readonly side: "BUY" | "SELL";
  readonly assetMint: string;
  readonly assetDecimals: number;
  readonly multiplier: string;
  readonly cashMint: string;
  readonly cashDecimals: number;
  readonly grossInput: string;
  readonly economicInput: string;
  readonly minimumOutput: string;
  readonly maximumFee: string;
  readonly feeBps: number;
  readonly exactFee?: boolean;
}

export interface ConfirmedReceiptMovements {
  readonly assetDelta: bigint;
  readonly cashDelta: bigint;
  readonly feeRaw: bigint;
  readonly slot: number;
  readonly executedAt: Date;
}

export interface ConfirmedTradeReceiptSource {
  fetch(request: ConfirmedReceiptRequest): Promise<ConfirmedReceiptMovements>;
}

export interface ConfirmedReceiptSnapshot {
  readonly quantity: string;
  readonly notional: string;
  readonly fee: string;
  readonly slot: number;
  readonly executedAt: Date;
}

export interface ConfirmedPositionUpdate {
  readonly executionId: string;
  readonly assetId: string;
  readonly side: "BUY" | "SELL";
  readonly executedQuantity: string | null;
  readonly quantity: string | null;
  readonly missingReceiptExecutionIds: readonly string[];
  readonly includedExecutionIds: readonly string[];
  readonly accountingReady: boolean;
  readonly marketValue: string | null;
  readonly unrealizedPnl: string | null;
  readonly unrealizedPnlPercent: string | null;
}

export interface ConfirmedTradeReceiptRepository {
  // Returns null when already captured, finalized accounting exists, or the
  // execution is not a confirmed trade owned by this user. No provider request
  // may be made for an unauthorized/unconfirmed execution.
  positionUpdate?(executionId: string, userId: string): Promise<ConfirmedPositionUpdate | null>;
  pendingRequest(executionId: string, userId: string): Promise<ConfirmedReceiptRequest | null>;
  save(request: ConfirmedReceiptRequest, snapshot: ConfirmedReceiptSnapshot): Promise<void>;
}

export class ConfirmedTradeReceiptService {
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(private readonly repository: ConfirmedTradeReceiptRepository, private readonly source: ConfirmedTradeReceiptSource) {}

  prepare(executionId: string, userId: string): Promise<void> {
    const key = `${userId}:${executionId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const work = this.capture(executionId, userId).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  async positionUpdate(executionId: string, userId: string): Promise<ConfirmedPositionUpdate | null> {
    let value = await this.repository.positionUpdate?.(executionId, userId) ?? null;
    if (value && value.missingReceiptExecutionIds.length > 0) {
      // Retry receipts missed by a previous process/request, including earlier
      // trades on this asset. Keep fan-out bounded and deduplicate in prepare().
      await Promise.all(value.missingReceiptExecutionIds.slice(0, 8).map(async (id) => {
        try { await this.prepare(id, userId); } catch { /* Preserve pending status. */ }
      }));
      value = await this.repository.positionUpdate?.(executionId, userId) ?? null;
    }
    return value;
  }

  private async capture(executionId: string, userId: string): Promise<void> {
    const request = await this.repository.pendingRequest(executionId, userId);
    if (request === null) return;
    const movement = await this.source.fetch(request);
    await this.repository.save(request, confirmedReceiptSnapshot(request, movement));
  }
}

export function confirmedReceiptSnapshot(request: ConfirmedReceiptRequest, movement: ConfirmedReceiptMovements): ConfirmedReceiptSnapshot {
  const buy = request.side === "BUY";
  const asset = buy ? movement.assetDelta : -movement.assetDelta;
  const cash = buy ? -movement.cashDelta : movement.cashDelta;
  if (!Number.isSafeInteger(request.feeBps) || request.feeBps < 0 || request.feeBps > 10000) throw new Error("Invalid execution fee rate.");
  // A SELL's absolute quoted fee is an estimate: actual gross proceeds can
  // differ by slippage/rounding. Bind the observed fee to the authorized rate
  // on actual gross proceeds, rounding the maximum up by at most one base unit.
  const maximumFee = buy || request.exactFee ? BigInt(request.maximumFee)
    : ((cash + movement.feeRaw) * BigInt(request.feeBps) + 9999n) / 10000n;
  if (asset <= 0n || cash <= 0n || movement.feeRaw < 0n || movement.feeRaw > maximumFee) {
    throw new Error("Confirmed trade movements do not match its side or fee limit.");
  }
  if(request.exactFee && movement.feeRaw !== maximumFee) throw new Error('Confirmed fee does not match the reviewed atomic collection.');
  // Unspent input stays in the wallet. Capture actual movements rather than
  // the maximum budget, while retaining the fee and minimum-output checks.
  if (buy ? !isBuyDebitWithinBudget(cash, BigInt(request.grossInput), movement.feeRaw) : asset > BigInt(request.grossInput)) {
    throw new Error("Confirmed trade input does not match the authorized execution.");
  }
  if ((buy ? asset : cash) < BigInt(request.minimumOutput)) throw new Error("Confirmed trade output is below its minimum.");
  return {
    quantity: rawQuantityTimesMultiplier(asset.toString(), request.assetDecimals, request.multiplier),
    notional: baseUnitsToExact(cash.toString(), request.cashDecimals),
    fee: baseUnitsToExact(movement.feeRaw.toString(), request.cashDecimals),
    slot: movement.slot, executedAt: movement.executedAt,
  };
}
