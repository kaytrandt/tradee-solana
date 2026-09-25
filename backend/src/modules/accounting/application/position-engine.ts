import { decimalString } from "../../assets/domain/asset.js";
import {
  AccountingError,
  AccountingEventSource,
  AccountingEventType,
  CostBasisStatus,
  CostBasisTreatment,
  PnlStatus,
  PositionStatus,
  type AccountingEvent,
  type PositionSnapshot,
} from "../domain/accounting.js";
import {
  addExact,
  compareExact,
  divideExact,
  exactRatioOf,
  isZeroExact,
  multiplyExact,
  subtractExact,
} from "../domain/exact-amount.js";

export class PositionEngine {
  rebuild(input: {
    readonly userId: string;
    readonly walletId: string;
    readonly assetId: string;
    readonly events: readonly AccountingEvent[];
    readonly lastReconciledAt?: Date | null;
    readonly version?: bigint;
  }): PositionSnapshot {
    let state = emptyPosition(input);
    for (const event of canonicalEvents(input.events)) {
      if (!event.affectsPosition || event.assetId !== input.assetId) continue;
      if (event.userId !== input.userId || event.walletId !== input.walletId) {
        throw new AccountingError("ACCOUNTING_EVENT_SCOPE_MISMATCH", "Accounting event does not belong to the position.");
      }
      state = this.apply(state, event);
    }
    return { ...state, version: input.version ?? BigInt(input.events.length) };
  }

  apply(position: PositionSnapshot, event: AccountingEvent): PositionSnapshot {
    switch (event.type) {
      case AccountingEventType.BUY:
        return this.applyKnownAcquisition(position, event);
      case AccountingEventType.FREE_STOCK:
        return event.costBasisTreatment === CostBasisTreatment.KNOWN_ACQUISITION
          ? this.applyKnownAcquisition(position, event) : this.applyUnknownAcquisition(position, event);
      case AccountingEventType.TRANSFER_IN:
        if(event.source===AccountingEventSource.SOLANA_EXTERNAL_TRANSFER && event.metadata.receivedBasisPolicy==='RECEIPT_VALUE_V1' &&
          event.costBasisTreatment===CostBasisTreatment.KNOWN_ACQUISITION) return this.applyKnownAcquisition(position,event);
        if(event.source===AccountingEventSource.RECONCILIATION && typeof event.metadata.migrationId==='string' &&
          event.costBasisTreatment===CostBasisTreatment.KNOWN_ACQUISITION) return this.applyKnownAcquisition(position,event);
        return this.applyUnknownAcquisition(position,event);
      case AccountingEventType.REFERRAL_REWARD:
        return this.applyUnknownAcquisition(position, event);
      case AccountingEventType.SELL:
        return this.applyOutflow(position, event, true);
      case AccountingEventType.TRANSFER_OUT:
        return this.applyOutflow(position, event, false);
      case AccountingEventType.DEPOSIT:
      case AccountingEventType.WITHDRAW:
      case AccountingEventType.FEE:
        return position;
    }
  }

  private applyKnownAcquisition(position: PositionSnapshot, event: AccountingEvent): PositionSnapshot {
    if (event.costBasisTreatment !== CostBasisTreatment.KNOWN_ACQUISITION || event.totalValue === null) {
      throw invalidEvent(event, "BUY requires a known acquisition value.");
    }
    const raw = BigInt(event.rawQuantity);
    requirePositive(raw, event);
    const knownDisplay = addExact(position.knownDisplayQuantity, event.displayQuantity);
    // Re-derive legacy CAPITALIZE events from actual cash, not the old policy or quote.
    // Already-expensed events are not reduced twice.
    const acquisitionCost = event.quoteAmount === null ? event.totalValue : subtractExact(event.quoteAmount, event.feeAmount ?? "0");
    if (compareExact(acquisitionCost, "0") <= 0 || (event.feeAmount !== null &&
        (compareExact(event.feeAmount, "0") < 0 || event.feeAssetMint !== event.quoteAssetMint))) {
      throw invalidEvent(event, "BUY requires positive cost after a nonnegative fee in the quote asset.");
    }
    const totalCostBasis = addExact(position.totalCostBasis, acquisitionCost);
    return finalize({
      ...position,
      rawQuantity: (BigInt(position.rawQuantity) + raw).toString(),
      knownRawQuantity: (BigInt(position.knownRawQuantity) + raw).toString(),
      displayQuantity: addExact(position.displayQuantity, event.displayQuantity),
      knownDisplayQuantity: knownDisplay,
      totalCostBasis,
      weightedAverageCost: isZeroExact(knownDisplay) ? null : divideExact(totalCostBasis, knownDisplay),
      lastAccountingEventAt: event.occurredAt,
    });
  }

  private applyUnknownAcquisition(position: PositionSnapshot, event: AccountingEvent): PositionSnapshot {
    if (event.costBasisTreatment !== CostBasisTreatment.UNKNOWN_ACQUISITION) {
      throw invalidEvent(event, `${event.type} requires explicitly unavailable cost basis.`);
    }
    const raw = BigInt(event.rawQuantity);
    requirePositive(raw, event);
    return finalize({
      ...position,
      rawQuantity: (BigInt(position.rawQuantity) + raw).toString(),
      unknownRawQuantity: (BigInt(position.unknownRawQuantity) + raw).toString(),
      displayQuantity: addExact(position.displayQuantity, event.displayQuantity),
      unknownDisplayQuantity: addExact(position.unknownDisplayQuantity, event.displayQuantity),
      lastAccountingEventAt: event.occurredAt,
    });
  }

  private applyOutflow(position: PositionSnapshot, event: AccountingEvent, isSale: boolean): PositionSnapshot {
    if(typeof event.metadata.migrationId==='string' &&
      (event.source!==AccountingEventSource.RECONCILIATION || isSale || event.rawQuantity!==position.rawQuantity ||
        position.unknownRawQuantity!=='0' || event.metadata.carriedCostBasis!==position.totalCostBasis)) {
      throw new AccountingError('ACCOUNTING_MIGRATION_BASIS_MISMATCH',
        'Migration basis must match the full source position at its canonical event time.',false);
    }
    const totalRaw = BigInt(position.rawQuantity);
    const outgoingRaw = BigInt(event.rawQuantity);
    requirePositive(outgoingRaw, event);
    if (outgoingRaw > totalRaw) {
      throw new AccountingError("ACCOUNTING_NEGATIVE_POSITION", "Accounting outflow exceeds the derived raw position.");
    }

    const knownRaw = BigInt(position.knownRawQuantity);
    const unknownRaw = BigInt(position.unknownRawQuantity);
    const knownRawRemoved = outgoingRaw === totalRaw
      ? knownRaw
      : (outgoingRaw * knownRaw) / totalRaw;
    const unknownRawRemoved = outgoingRaw - knownRawRemoved;
    if (unknownRawRemoved > unknownRaw) throw invalidEvent(event, "Unknown-basis allocation exceeds the position.");

    const knownDisplayRemoved = knownRawRemoved === 0n || knownRaw === 0n
      ? decimalString("0")
      : exactRatioOf(position.knownDisplayQuantity, knownRawRemoved, knownRaw);
    const unknownDisplayRemoved = unknownRawRemoved === 0n || unknownRaw === 0n
      ? decimalString("0")
      : exactRatioOf(position.unknownDisplayQuantity, unknownRawRemoved, unknownRaw);
    const displayRemoved = addExact(knownDisplayRemoved, unknownDisplayRemoved);
    const costRemoved = knownRawRemoved === 0n || isZeroExact(position.knownDisplayQuantity)
      ? decimalString("0")
      : knownRawRemoved === knownRaw
        ? position.totalCostBasis
        : exactRatioOf(position.totalCostBasis, knownRawRemoved, knownRaw);
    const remainingKnownDisplay = nonNegativeSubtract(position.knownDisplayQuantity, knownDisplayRemoved);
    const remainingUnknownDisplay = nonNegativeSubtract(position.unknownDisplayQuantity, unknownDisplayRemoved);
    const remainingBasis = nonNegativeSubtract(position.totalCostBasis, costRemoved);

    let realizedPnl = position.realizedPnl;
    let pnlStatus = position.pnlStatus;
    if (isSale) {
      if (event.costBasisTreatment !== CostBasisTreatment.KNOWN_DISPOSITION || event.totalValue === null) {
        throw invalidEvent(event, "SELL requires normalized net proceeds.");
      }
      const knownProceeds = knownRawRemoved === 0n
        ? decimalString("0")
        : exactRatioOf(event.totalValue, knownRawRemoved, outgoingRaw);
      realizedPnl = addExact(realizedPnl, subtractExact(knownProceeds, costRemoved));
      if (unknownRawRemoved > 0n) pnlStatus = PnlStatus.PARTIAL;
    } else if (event.costBasisTreatment !== CostBasisTreatment.TRANSFER_OUT) {
      throw invalidEvent(event, "TRANSFER_OUT must not be treated as a sale.");
    }

    const next = finalize({
      ...position,
      rawQuantity: (totalRaw - outgoingRaw).toString(),
      knownRawQuantity: (knownRaw - knownRawRemoved).toString(),
      unknownRawQuantity: (unknownRaw - unknownRawRemoved).toString(),
      displayQuantity: nonNegativeSubtract(position.displayQuantity, displayRemoved),
      knownDisplayQuantity: remainingKnownDisplay,
      unknownDisplayQuantity: remainingUnknownDisplay,
      totalCostBasis: remainingBasis,
      weightedAverageCost: isZeroExact(remainingKnownDisplay) ? null : divideExact(remainingBasis, remainingKnownDisplay),
      realizedPnl,
      pnlStatus,
      lastAccountingEventAt: event.occurredAt,
    });
    if (next.rawQuantity === "0") {
      return {
        ...next,
        displayQuantity: decimalString("0"),
        knownDisplayQuantity: decimalString("0"),
        unknownDisplayQuantity: decimalString("0"),
        totalCostBasis: decimalString("0"),
        weightedAverageCost: null,
      };
    }
    return next;
  }
}

export function canonicalEvents(events: readonly AccountingEvent[]): readonly AccountingEvent[] {
  return [...events].sort((left, right) => {
    if (left.slot !== right.slot) return left.slot < right.slot ? -1 : 1;
    if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
    if (left.eventIndex !== right.eventIndex) return left.eventIndex - right.eventIndex;
    return left.sourceKey.localeCompare(right.sourceKey);
  });
}

function emptyPosition(input: {
  readonly userId: string;
  readonly walletId: string;
  readonly assetId: string;
  readonly lastReconciledAt?: Date | null;
  readonly version?: bigint;
}): PositionSnapshot {
  return {
    userId: input.userId,
    walletId: input.walletId,
    assetId: input.assetId,
    rawQuantity: "0",
    knownRawQuantity: "0",
    unknownRawQuantity: "0",
    displayQuantity: decimalString("0"),
    knownDisplayQuantity: decimalString("0"),
    unknownDisplayQuantity: decimalString("0"),
    totalCostBasis: decimalString("0"),
    weightedAverageCost: null,
    realizedPnl: decimalString("0"),
    costBasisStatus: CostBasisStatus.KNOWN,
    pnlStatus: PnlStatus.AVAILABLE,
    status: PositionStatus.CLOSED,
    lastAccountingEventAt: null,
    lastReconciledAt: input.lastReconciledAt ?? null,
    version: input.version ?? 0n,
  };
}

function finalize(position: PositionSnapshot): PositionSnapshot {
  const known = BigInt(position.knownRawQuantity);
  const unknown = BigInt(position.unknownRawQuantity);
  const costBasisStatus = unknown === 0n
    ? CostBasisStatus.KNOWN
    : known === 0n ? CostBasisStatus.UNAVAILABLE : CostBasisStatus.PARTIAL;
  let pnlStatus = position.pnlStatus;
  if (pnlStatus !== PnlStatus.PARTIAL) {
    pnlStatus = costBasisStatus === CostBasisStatus.KNOWN
      ? PnlStatus.AVAILABLE
      : costBasisStatus === CostBasisStatus.PARTIAL ? PnlStatus.PARTIAL : PnlStatus.UNAVAILABLE;
  }
  return {
    ...position,
    costBasisStatus,
    pnlStatus,
    status: position.rawQuantity === "0" ? PositionStatus.CLOSED : PositionStatus.OPEN,
  };
}

function nonNegativeSubtract(left: string, right: string) {
  const result = subtractExact(left, right);
  if (compareExact(result, "0") < 0) throw new AccountingError("ACCOUNTING_NEGATIVE_POSITION", "Accounting decimal quantity became negative.");
  return result;
}

function requirePositive(value: bigint, event: AccountingEvent): void {
  if (value <= 0n) throw invalidEvent(event, "Accounting event quantity must be positive.");
}

function invalidEvent(event: AccountingEvent, message: string): AccountingError {
  return new AccountingError("ACCOUNTING_INVALID_EVENT", `${message} Event ${event.eventId}.`);
}
