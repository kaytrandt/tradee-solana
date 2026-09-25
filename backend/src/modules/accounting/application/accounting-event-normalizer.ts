import { createHash } from "node:crypto";
import { decimalString } from "../../assets/domain/asset.js";
import {
  AccountingError,
  AccountingEventSource,
  AccountingEventState,
  AccountingEventType,
  ChainFinality,
  CostBasisTreatment,
  type AccountingAssetSnapshot,
  type AccountingClassificationHint,
  type AccountingContextResolver,
  type AccountingEvent,
  type AccountingTradeContext,
  type BuyFeeCostBasisPolicy,
  type ChainObservation,
  type ChainObservationBatch,
  type RewardCostBasisPolicy,
} from "../domain/accounting.js";
import { baseUnitsToExact } from "../domain/exact-amount.js";
import { AssetQuantityConverter } from "./asset-quantity-converter.js";

export interface AccountingPolicy {
  readonly buyFeeCostBasis: BuyFeeCostBasisPolicy;
  readonly rewardCostBasis: RewardCostBasisPolicy;
  readonly recognizedDepositMint: string;
  readonly externalClassificationDelayMs: number;
}

export interface NormalizationResult {
  readonly state: "normalized" | "pending";
  readonly reason: string | null;
  readonly events: readonly AccountingEvent[];
}

export class AccountingEventNormalizer {
  constructor(
    private readonly contexts: AccountingContextResolver,
    private readonly quantities: AssetQuantityConverter,
    private readonly policy: AccountingPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async normalize(batch: ChainObservationBatch): Promise<NormalizationResult> {
    if (batch.finality !== ChainFinality.FINALIZED) {
      return { state: "pending", reason: "transaction_not_finalized", events: [] };
    }
    const migration=await this.contexts.resolveMigration?.(batch.signature,batch.walletId);
    if(migration && !migration.pending) {
      const outgoing=batch.observations.find(o=>o.mint===migration.source.mint&&o.direction==='OUT');
      const incoming=batch.observations.find(o=>o.mint===migration.destination.mint&&o.direction==='IN');
      if(batch.observations.length!==2||!outgoing||!incoming||outgoing.rawQuantity!==migration.rawAmount||BigInt(incoming.rawQuantity)<BigInt(migration.minimumOutput))
        throw mismatch('Asset migration does not match finalized movements.');
      const events=[{observation:outgoing,asset:migration.source,type:AccountingEventType.TRANSFER_OUT,treatment:CostBasisTreatment.TRANSFER_OUT},
        {observation:incoming,asset:migration.destination,type:AccountingEventType.TRANSFER_IN,treatment:CostBasisTreatment.KNOWN_ACQUISITION}].map(item=>{
        const converted=this.quantities.convertRawQuantity(item.observation.rawQuantity,item.asset);
        return createEvent({observation:item.observation,suffix:`migration:${item.type}`,type:item.type,source:AccountingEventSource.RECONCILIATION,
          asset:item.asset,displayQuantity:converted.displayQuantity,multiplierUsed:converted.multiplierUsed,quantityModelVersion:converted.quantityModelVersion,
          quoteAssetMint:null,quoteAmount:null,totalValue:migration.costBasis,feeAmount:null,feeAssetMint:null,costBasisTreatment:item.treatment,
          affectsPosition:true,tradeOrderId:null,tradeExecutionId:null,rewardId:null,ingestedAt:this.now(),
          metadata:{migrationId:migration.id,migrationSourceAssetId:migration.source.assetId,migrationDestinationAssetId:migration.destination.assetId,
            carriedCostBasis:migration.costBasis,fullSourceRaw:migration.rawAmount,realizesPnl:false}});
      });
      return {state:'normalized',reason:null,events};
    }
    const trade = await this.contexts.resolveTrade(batch.signature, batch.walletId);
    if (trade !== null) return { state: "normalized", reason: null, events: this.normalizeTrade(batch, trade) };
    const hint = await this.contexts.resolveHint(batch.signature, batch.walletId);
    if (hint !== null) return { state: "normalized", reason: null, events: this.normalizeHint(batch, hint) };
    // A finalized transaction with one inbound canonical-USDC balance change is
    // an unambiguous external deposit. Do not hold it behind the internal trade
    // context grace period: swaps have more than one wallet token movement and
    // continue through the delayed path below.
    if (isUnambiguousCanonicalDeposit(batch, this.policy.recognizedDepositMint)) {
      return { state: "normalized", reason: null, events: await this.normalizeExternal(batch) };
    }
    // An unresolved migration must not delay unrelated registered trades,
    // rewards, withdrawals or an unambiguous canonical-USDC deposit.
    if(migration?.pending) return {state:'pending',reason:'awaiting_migration_confirmation',events:[]};
    // A single incoming stock movement has no swap debit. Resolve registered
    // trades/rewards/migrations first, then apply the verified receipt immediately
    // instead of imposing the two-minute grace period intended for ambiguous swaps.
    const incoming = batch.observations.length === 1 ? batch.observations[0] : undefined;
    if (incoming?.direction === 'IN' && BigInt(incoming.rawQuantity) > 0n
      && incoming.mint !== this.policy.recognizedDepositMint
      && await this.contexts.findAssetByMint(incoming.mint) !== null) {
      return { state: 'normalized', reason: null, events: await this.normalizeExternal(batch) };
    }
    if (this.now().getTime() - batch.blockTime.getTime() < this.policy.externalClassificationDelayMs) {
      return { state: "pending", reason: "awaiting_internal_context", events: [] };
    }
    return { state: "normalized", reason: null, events: await this.normalizeExternal(batch) };
  }

  private normalizeTrade(batch: ChainObservationBatch, trade: AccountingTradeContext): readonly AccountingEvent[] {
    const assetObservation = batch.observations.find((item) => item.mint === trade.asset.mint);
    const cashObservation = batch.observations.find((item) => item.mint === trade.usdcMint);
    if (assetObservation === undefined || cashObservation === undefined) {
      throw mismatch("Trade transaction is missing its asset or USDC movement.");
    }
    const expectedAssetDirection = trade.side === "BUY" ? "IN" : "OUT";
    const expectedCashDirection = trade.side === "BUY" ? "OUT" : "IN";
    if (assetObservation.direction !== expectedAssetDirection || cashObservation.direction !== expectedCashDirection) {
      throw mismatch("Trade transaction directions do not match the TradeOrder.");
    }
    const fixedInput = trade.side === "BUY" ? cashObservation : assetObservation;
    // Atomic fees are fixed, even when a BUY route leaves input unspent.
    // Preserve legacy provider-fee inference for older executions only.
    const observedBuyFeeRaw = trade.side === "BUY" && !trade.exactFee
      ? (BigInt(cashObservation.rawQuantity) - BigInt(trade.economicTradingAmount)).toString()
      : trade.feeAmount;
    if (trade.side === "BUY") {
      if (
        (trade.exactFee
          ? BigInt(cashObservation.rawQuantity) <= BigInt(trade.feeAmount)
          : BigInt(cashObservation.rawQuantity) < BigInt(trade.economicTradingAmount))
        || BigInt(cashObservation.rawQuantity) > BigInt(trade.grossInputAmount)
        || BigInt(observedBuyFeeRaw) > BigInt(trade.feeAmount)
      ) {
        throw mismatch("Finalized BUY cash movement does not match TradeExecution economics.");
      }
    } else if (BigInt(fixedInput.rawQuantity) <= 0n || BigInt(fixedInput.rawQuantity) > BigInt(trade.grossInputAmount)) {
      // Authorized input is a maximum, not a guaranteed wallet debit.
      // Record the finalized debit, while retaining the authorized input cap
      // and the minimum output check below.
      throw mismatch("Finalized SELL input movement exceeds TradeExecution authorization.");
    }
    const actualOutput = trade.side === "BUY" ? assetObservation : cashObservation;
    if (BigInt(actualOutput.rawQuantity) < BigInt(trade.minimumOutputAmount)) {
      throw mismatch("Finalized output movement is below the TradeQuote minimum.");
    }

    const converted = this.quantities.convertRawQuantity(assetObservation.rawQuantity, trade.asset);
    const totalValue = trade.side === "BUY"
      ? baseUnitsToExact(
        (BigInt(cashObservation.rawQuantity) - BigInt(observedBuyFeeRaw)).toString(),
        trade.usdcDecimals,
      )
      : baseUnitsToExact(cashObservation.rawQuantity, trade.usdcDecimals);
    const quoteAmount = baseUnitsToExact(cashObservation.rawQuantity, trade.usdcDecimals);
    const appliedFeeRaw = trade.side === "BUY" ? observedBuyFeeRaw : trade.feeAmount;
    const fee = baseUnitsToExact(appliedFeeRaw, trade.usdcDecimals);
    const eventType = trade.side === "BUY" ? AccountingEventType.BUY : AccountingEventType.SELL;
    const main = createEvent({
      observation: assetObservation,
      suffix: eventType.toLowerCase(),
      type: eventType,
      source: AccountingEventSource.TRADEE_TRADE,
      asset: trade.asset,
      displayQuantity: converted.displayQuantity,
      multiplierUsed: converted.multiplierUsed,
      quantityModelVersion: converted.quantityModelVersion,
      quoteAssetMint: trade.usdcMint,
      quoteAmount,
      totalValue,
      feeAmount: fee,
      feeAssetMint: trade.usdcMint,
      costBasisTreatment: trade.side === "BUY"
        ? CostBasisTreatment.KNOWN_ACQUISITION
        : CostBasisTreatment.KNOWN_DISPOSITION,
      affectsPosition: true,
      tradeOrderId: trade.orderId,
      tradeExecutionId: trade.executionId,
      rewardId: null,
      ingestedAt: this.now(),
      metadata: {
        cashObservationSourceKey: cashObservation.sourceKey,
        buyFeeCostBasisPolicy: "EXPENSE",
        sellProceedsAreNetOfTradeeFee: trade.side === "SELL",
        quotedOutputRawQuantity: trade.netOutputAmount,
        minimumOutputRawQuantity: trade.minimumOutputAmount,
        actualOutputRawQuantity: actualOutput.rawQuantity,
        quotedFeeRawQuantity: trade.feeAmount,
        observedFeeRawQuantity: appliedFeeRaw,
      },
    });
    if (appliedFeeRaw === "0") return [main];
    return [main, createEvent({
      observation: cashObservation,
      rawQuantity: appliedFeeRaw,
      suffix: "fee",
      type: AccountingEventType.FEE,
      source: AccountingEventSource.TRADEE_TRADE,
      asset: null,
      displayQuantity: fee,
      multiplierUsed: decimalString("1"),
      quantityModelVersion: 1,
      quoteAssetMint: trade.usdcMint,
      quoteAmount: fee,
      totalValue: fee,
      feeAmount: fee,
      feeAssetMint: trade.usdcMint,
      costBasisTreatment: CostBasisTreatment.INFORMATIONAL,
      affectsPosition: false,
      tradeOrderId: trade.orderId,
      tradeExecutionId: trade.executionId,
      rewardId: null,
      ingestedAt: this.now(),
      metadata: { linkedEventId: main.eventId, economicEffect: "INFORMATIONAL_ONLY" },
    })];
  }

  private normalizeHint(batch: ChainObservationBatch, hint: AccountingClassificationHint): readonly AccountingEvent[] {
    const observation = batch.observations.find((item) => item.mint === hint.mint);
    if (observation === undefined) throw mismatch("Classification hint does not match a token movement.");
    const expected = hint.type === AccountingEventType.WITHDRAW ? "OUT" : "IN";
    if (observation.direction !== expected) throw mismatch("Classification hint has the wrong movement direction.");
    if (
      (hint.type === AccountingEventType.DEPOSIT || hint.type === AccountingEventType.WITHDRAW)
      && hint.mint !== this.policy.recognizedDepositMint
    ) {
      throw mismatch("Only the configured Solana USDC mint can be classified as a Tradee deposit or withdrawal.");
    }
    const isReward = hint.type === AccountingEventType.FREE_STOCK || hint.type === AccountingEventType.REFERRAL_REWARD;
    const cashReferral = hint.type === AccountingEventType.REFERRAL_REWARD && hint.mint === this.policy.recognizedDepositMint;
    if (isReward && !cashReferral && hint.asset === null) throw mismatch("Stock reward does not resolve to a Tradee asset.");
    if (cashReferral && (observation.decimals !== 6 || hint.metadata.expectedUsdcBaseUnits !== observation.rawQuantity)) {
      throw mismatch("Referral receipt does not match its immutable payout amount.");
    }
    if (isReward && hint.rewardId === null) throw mismatch("Stock reward is missing its immutable reward identity.");
    const acquisition = hint.type === AccountingEventType.FREE_STOCK && this.policy.rewardCostBasis === "RECEIPT_VALUE"
      ? hint.acquisition : undefined;
    if (acquisition && BigInt(acquisition.receivedBaseUnits) !== BigInt(observation.rawQuantity)) {
      throw mismatch("Reward receipt quantity does not match finalized ownership.");
    }
    const display = hint.asset === null
      ? baseUnitsToExact(observation.rawQuantity, observation.decimals)
      : this.quantities.convertRawQuantity(observation.rawQuantity, hint.asset).displayQuantity;
    return [createEvent({
      observation,
      suffix: hint.type.toLowerCase(),
      type: hint.type,
      source: hintSource(hint.type),
      asset: hint.asset,
      displayQuantity: display,
      multiplierUsed: hint.asset?.quantityMultiplier ?? decimalString("1"),
      quantityModelVersion: hint.asset?.quantityModelVersion ?? 1,
      quoteAssetMint: null,
      quoteAmount: null,
      totalValue: acquisition?.value ?? null,
      feeAmount: null,
      feeAssetMint: null,
      costBasisTreatment: acquisition ? CostBasisTreatment.KNOWN_ACQUISITION
        : isReward && !cashReferral ? CostBasisTreatment.UNKNOWN_ACQUISITION : CostBasisTreatment.INFORMATIONAL,
      affectsPosition: isReward && !cashReferral,
      tradeOrderId: null,
      tradeExecutionId: null,
      rewardId: hint.rewardId,
      ingestedAt: this.now(),
      metadata: { ...hint.metadata, rewardCostBasisPolicy: isReward ? this.policy.rewardCostBasis : undefined },
    })];
  }

  private async normalizeExternal(batch: ChainObservationBatch): Promise<readonly AccountingEvent[]> {
    const events: AccountingEvent[] = [];
    for (const observation of batch.observations) {
      if (observation.mint === this.policy.recognizedDepositMint) {
        {
          const incoming = observation.direction === "IN";
          events.push(createEvent({
            observation,
            suffix: incoming ? "deposit" : "withdraw",
            type: incoming ? AccountingEventType.DEPOSIT : AccountingEventType.WITHDRAW,
            source: incoming ? AccountingEventSource.DEPOSIT_SYSTEM : AccountingEventSource.SOLANA_EXTERNAL_TRANSFER,
            asset: null,
            displayQuantity: baseUnitsToExact(observation.rawQuantity, observation.decimals),
            multiplierUsed: decimalString("1"),
            quantityModelVersion: 1,
            quoteAssetMint: null,
            quoteAmount: null,
            totalValue: null,
            feeAmount: null,
            feeAssetMint: null,
            costBasisTreatment: CostBasisTreatment.INFORMATIONAL,
            affectsPosition: false,
            tradeOrderId: null,
            tradeExecutionId: null,
            rewardId: null,
            ingestedAt: this.now(),
            metadata: { method: "CRYPTO_TRANSFER", canonicalCashAsset: true },
          }));
        }
        continue;
      }
      const asset = await this.contexts.findAssetByMint(observation.mint);
      if (asset === null) continue;
      const converted = this.quantities.convertRawQuantity(observation.rawQuantity, asset);
      const incoming = observation.direction === "IN";
      const receipt = incoming ? await this.contexts.resolveReceivedBasis?.(
        asset.assetId, observation.mint, observation.rawQuantity, observation.occurredAt) : null;
      events.push(createEvent({
        observation,
        suffix: incoming ? "transfer-in" : "transfer-out",
        type: incoming ? AccountingEventType.TRANSFER_IN : AccountingEventType.TRANSFER_OUT,
        source: AccountingEventSource.SOLANA_EXTERNAL_TRANSFER,
        asset,
        displayQuantity: converted.displayQuantity,
        multiplierUsed: converted.multiplierUsed,
        quantityModelVersion: converted.quantityModelVersion,
        quoteAssetMint: null,
        quoteAmount: null,
        totalValue: receipt?.value ?? null,
        feeAmount: null,
        feeAssetMint: null,
        costBasisTreatment: incoming ? receipt?.value != null ? CostBasisTreatment.KNOWN_ACQUISITION
          : CostBasisTreatment.UNKNOWN_ACQUISITION : CostBasisTreatment.TRANSFER_OUT,
        affectsPosition: true,
        tradeOrderId: null,
        tradeExecutionId: null,
        rewardId: null,
        ingestedAt: this.now(),
        metadata: { costBasisKnown: receipt?.value != null,
          ...(receipt ? { receivedBasisPolicy: 'RECEIPT_VALUE_V1', receiptTokenPrice: receipt.tokenPrice,
            receiptPriceSource: receipt.source, receiptPriceObservedAt: receipt.priceObservedAt } : {}) },
      }));
    }
    return events;
  }
}

function isUnambiguousCanonicalDeposit(batch: ChainObservationBatch, canonicalMint: string): boolean {
  if (batch.observations.length !== 1) return false;
  const observation = batch.observations[0];
  return observation !== undefined
    && observation.mint === canonicalMint
    && observation.direction === "IN"
    && BigInt(observation.rawQuantity) > 0n;
}

interface CreateEventInput {
  readonly observation: ChainObservation;
  readonly rawQuantity?: string;
  readonly suffix: string;
  readonly type: AccountingEventType;
  readonly source: AccountingEventSource;
  readonly asset: AccountingAssetSnapshot | null;
  readonly displayQuantity: ReturnType<typeof decimalString>;
  readonly multiplierUsed: ReturnType<typeof decimalString>;
  readonly quantityModelVersion: number;
  readonly quoteAssetMint: string | null;
  readonly quoteAmount: ReturnType<typeof decimalString> | null;
  readonly totalValue: ReturnType<typeof decimalString> | null;
  readonly feeAmount: ReturnType<typeof decimalString> | null;
  readonly feeAssetMint: string | null;
  readonly costBasisTreatment: CostBasisTreatment;
  readonly affectsPosition: boolean;
  readonly tradeOrderId: string | null;
  readonly tradeExecutionId: string | null;
  readonly rewardId: string | null;
  readonly ingestedAt: Date;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function createEvent(input: CreateEventInput): AccountingEvent {
  const sourceKey = `${input.observation.sourceKey}:${input.suffix}`;
  return {
    eventId: createHash("sha256").update(sourceKey).digest("hex"),
    sourceKey,
    userId: input.observation.userId,
    walletId: input.observation.walletId,
    type: input.type,
    source: input.source,
    state: AccountingEventState.NORMALIZED,
    assetId: input.asset?.assetId ?? null,
    assetMint: input.observation.mint,
    rawQuantity: input.rawQuantity ?? input.observation.rawQuantity,
    displayQuantity: input.displayQuantity,
    multiplierUsed: input.multiplierUsed,
    quantityModelVersion: input.quantityModelVersion,
    quoteAssetMint: input.quoteAssetMint,
    quoteAmount: input.quoteAmount,
    totalValue: input.totalValue,
    feeAmount: input.feeAmount,
    feeAssetMint: input.feeAssetMint,
    costBasisTreatment: input.costBasisTreatment,
    affectsPosition: input.affectsPosition,
    sourceTransactionSignature: input.observation.signature,
    slot: input.observation.slot,
    transactionIndex: input.observation.transactionIndex,
    eventIndex: input.observation.eventIndex,
    tradeOrderId: input.tradeOrderId,
    tradeExecutionId: input.tradeExecutionId,
    rewardId: input.rewardId,
    occurredAt: input.observation.occurredAt,
    ingestedAt: input.ingestedAt,
    metadata: input.metadata,
  };
}

function hintSource(type: AccountingEventType): AccountingEventSource {
  switch (type) {
    case AccountingEventType.DEPOSIT: return AccountingEventSource.DEPOSIT_SYSTEM;
    case AccountingEventType.WITHDRAW: return AccountingEventSource.WITHDRAW_SYSTEM;
    case AccountingEventType.FREE_STOCK: return AccountingEventSource.REWARD_SYSTEM;
    case AccountingEventType.REFERRAL_REWARD: return AccountingEventSource.REFERRAL_SYSTEM;
    default: throw new Error("Unsupported classification hint.");
  }
}

function mismatch(message: string): AccountingError {
  return new AccountingError("ACCOUNTING_CHAIN_CONTEXT_MISMATCH", message, true);
}
