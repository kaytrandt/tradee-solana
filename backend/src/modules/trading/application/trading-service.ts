import { RecentFeeValidations } from "./recent-fee-validations.js";
import { STOCKMEME_SLIPPAGE_BPS } from "../../assets/domain/stockmeme-catalog.js";
import { randomUUID } from "node:crypto";
import {
  addBaseUnits,
  BaseUnitAmountError,
  decimalToBaseUnits,
  scaledQuantityToBaseUnits,
  type BaseUnitAmount,
} from "../domain/base-units.js";
import {
  assertTradeOrderTransition, TradeOrderState, TradingEngineError, TradingProviderName,
  type CreateTradeRequest, type GasSponsorshipPolicy, type PlatformFeeMode,
  type SolanaExecutionGateway, type SponsoredTransactionEvent,
  type SponsoredTransactionProvider, type SubmitTradeRequest, type TradeAggregate,
  type PrepareTradeAuthorizationRequest, type SponsoredTransactionAuthorizationChallenge,
  type TradeExecution, type TradeOrder, type TradeOrderRepository, type TradeQuote,
  type TradingProvider, type TradingWalletLookup, type TradingWalletRecord,
} from "../domain/trading.js";
import { TradingChain, TradingSide } from "../../transaction-policy/domain/trading-policy.js";
import type { TradingPolicyService } from "../../transaction-policy/application/trading-policy-service.js";
import { parseExactDecimal } from "../../transaction-policy/domain/exact-decimal.js";
import { FeeEngine } from "./fee-engine.js";
import type { ChargedTradeQuote } from './charged-trade-quote.js';
import type { TransactionFeeQuote } from '../../transaction-policy/domain/transaction-fees.js';
import { effectiveQuantityMultiplier } from '../../assets/domain/quantity-multiplier.js';
import { compareExact } from '../../accounting/domain/exact-amount.js';
import { assessTradeExecutionRisk } from "./trade-risk-engine.js";
import { digestTransaction, type SolanaTradeTransactionValidator } from "./solana-trade-transaction-validator.js";

export interface TradingServiceConfiguration {
  readonly usdcMint: string;
  readonly usdcDecimals: number;
  readonly feeAccountUsdc: string;
  /** Strict lower bound for a SELL's quoted gross USDC proceeds. */
  readonly minimumSellGrossProceeds: BaseUnitAmount;
  readonly defaultSlippageBps: number;
  readonly minimumSlippageBps: number;
  readonly maximumSlippageBps: number;
  /** Grace period before a Privy `not_found` result may release a stuck submission claim. */
  readonly submissionRecoveryDelayMs: number;
}

function assertQuantitySnapshot(asset: import('../../assets/domain/asset.js').Asset, quote: TradeQuote, at: Date) {
  if (compareExact(effectiveQuantityMultiplier(asset, at), quote.quantityMultiplier ?? '1') !== 0) {
    throw new TradingEngineError('TRADE_TRANSACTION_EXPIRED', 'Stock quantity units changed. Please request a new quote.', true);
  }
}

export class TradingService {
  constructor(
    private readonly policy: Pick<TradingPolicyService, "validateTrade">,
    private readonly wallets: TradingWalletLookup,
    private readonly orders: TradeOrderRepository,
    private readonly provider: TradingProvider,
    private readonly feeEngine: FeeEngine,
    private readonly solana: SolanaExecutionGateway,
    private readonly sponsoredTransactions: SponsoredTransactionProvider,
    private readonly sponsorshipPolicy: GasSponsorshipPolicy,
    private readonly transactionValidator: SolanaTradeTransactionValidator,
    private readonly configuration: TradingServiceConfiguration,
    private readonly now: () => Date = () => new Date(),
    private readonly confirmedReceipts?: { prepare(executionId: string, userId: string): Promise<void>;
      positionUpdate?(executionId: string, userId: string): Promise<import("./confirmed-trade-receipt-service.js").ConfirmedPositionUpdate | null> },
    private readonly chargedQuotes?: ChargedTradeQuote,
    private readonly recentFeeValidations = new RecentFeeValidations(),
  ) {
    if (provider.name !== TradingProviderName.DFLOW) throw new Error("Unsupported trading provider.");
  }

  async createOrder(request: CreateTradeRequest): Promise<TradeAggregate> {
    const existing = await this.orders.findByUserAndIdempotencyKey(request.userId, request.idempotencyKey);
    if (existing !== null) { requireSameRequest(existing.order, request); return existing; }
    const wallet = await this.wallets.findOwnedSolanaWallet(request.userId, request.walletAddress);
    if (wallet === null) throw new TradingEngineError("TRADE_PROVIDER_REJECTED", "The wallet is not eligible to trade.");
    const validated = await this.policy.validateTrade({
      userId: request.userId,
      wallet: { address: wallet.address, chain: TradingChain.SOLANA },
      assetId: request.assetId,
      side: request.side,
      amount: request.amount,
    });
    const now = this.now();
    const order: TradeOrder = {
      orderId: randomUUID(), userId: request.userId, walletId: wallet.id,
      walletAddress: wallet.address, assetId: validated.asset.id, side: validated.side,
      requestedAmount: validated.amount, quoteId: null, state: TradeOrderState.CREATED,
      quantityUnit: request.quantityUnit ?? 'TOKEN',
      provider: this.provider.name, idempotencyKey: request.idempotencyKey,
      submissionClaimedAt: null, submissionPayloadHash: null, createdAt: now, updatedAt: now,
      riskAcknowledgedAt: null, failureCode: null,
    };
    const reservation = await this.orders.reserve(order);
    if (!reservation.created) { requireSameRequest(reservation.aggregate.order, request); return reservation.aggregate; }

    try {
      const slippageBps = validated.asset.assetClass === "stockmemes"
        ? STOCKMEME_SLIPPAGE_BPS : this.normalizeSlippage(request.slippageBps);
      const isBuy = validated.side === TradingSide.BUY;
      const inputMint = isBuy ? this.configuration.usdcMint : validated.asset.solanaMint;
      const outputMint = isBuy ? validated.asset.solanaMint : this.configuration.usdcMint;
      const inputDecimals = isBuy ? this.configuration.usdcDecimals : validated.asset.decimals;
      const quantityMultiplier = effectiveQuantityMultiplier(validated.asset, now);
      const inputAmount = tradeAmountToBaseUnits(validated.amount, inputDecimals,
        !isBuy && request.quantityUnit === 'DISPLAY' ? quantityMultiplier : '1');
      const feeMode: PlatformFeeMode = isBuy ? "inputMint" : "outputMint";
      let feeQuote: TransactionFeeQuote | undefined;
      let feeTerms = isBuy
        ? this.feeEngine.solanaTieredFee(inputAmount, this.configuration.usdcDecimals)
        : { targetFee: inputAmount, effectiveFeeBps: 50 };
      let prepared: import('../domain/trading.js').ProviderPreparedOrder;
      if(this.chargedQuotes){
        const charged=await this.chargedQuotes.prepare({inputMint,outputMint,amount:inputAmount,userPublicKey:wallet.address,
          slippageBps,platformFeeBps:0,platformFeeMode:feeMode,feeAccount:this.configuration.feeAccountUsdc},isBuy?'BUY':'SELL',
          {userId:order.userId,referenceId:privyReference(order.orderId)});
        prepared=charged;feeQuote=charged.feeQuote;
        if(!isBuy)this.assertMinimumSellGrossProceeds(addBaseUnits(prepared.outputAmount,prepared.platformFeeAmount));
      }else{
      prepared = await this.provider.createOrder({
        inputMint, outputMint, amount: inputAmount, userPublicKey: wallet.address,
        slippageBps, platformFeeBps: feeTerms.effectiveFeeBps, platformFeeMode: feeMode,
        feeAccount: this.configuration.feeAccountUsdc,
      });
      if (!isBuy) {
        const grossOutput = addBaseUnits(prepared.outputAmount, prepared.platformFeeAmount);
        this.assertMinimumSellGrossProceeds(grossOutput);
        const correctedTerms = this.feeEngine.solanaTieredFee(grossOutput, this.configuration.usdcDecimals);
        if (correctedTerms.effectiveFeeBps !== feeTerms.effectiveFeeBps) {
          feeTerms = correctedTerms;
          prepared = await this.provider.createOrder({
            inputMint, outputMint, amount: inputAmount, userPublicKey: wallet.address,
            slippageBps, platformFeeBps: feeTerms.effectiveFeeBps, platformFeeMode: feeMode,
            feeAccount: this.configuration.feeAccountUsdc,
          });
        }
        const finalGrossOutput = addBaseUnits(prepared.outputAmount, prepared.platformFeeAmount);
        this.assertMinimumSellGrossProceeds(finalGrossOutput);
        const finalTerms = this.feeEngine.solanaTieredFee(finalGrossOutput, this.configuration.usdcDecimals);
        if (finalTerms.effectiveFeeBps !== feeTerms.effectiveFeeBps) {
          throw new TradingEngineError(
            "TRADE_FEE_MISMATCH",
            "The SELL quote moved across a platform-fee tier while being prepared.",
            true,
          );
        }
      }
      this.feeEngine.verifyProviderFee(prepared, feeTerms.effectiveFeeBps, feeMode);
      }
      const economics = isBuy
        ? this.feeEngine.buyEconomicsWithProviderFee(inputAmount, prepared.platformFeeAmount)
        : null;
      const settlementAmount = isBuy
        ? inputAmount
        : addBaseUnits(prepared.outputAmount, prepared.platformFeeAmount);
      const executionRisk = assessTradeExecutionRisk(
        settlementAmount,
        this.configuration.usdcDecimals,
        prepared.priceImpact,
      );
      assertTradeOrderTransition(TradeOrderState.CREATED, TradeOrderState.QUOTED);
      assertTradeOrderTransition(TradeOrderState.QUOTED, TradeOrderState.AWAITING_SIGNATURE);
      const quote: TradeQuote = {
        ...(feeQuote?{feeQuote}:{}),
        quantityMultiplier,
        quoteId: randomUUID(), orderId: order.orderId, assetId: validated.asset.id,
        side: validated.side, inputMint, outputMint, grossInputAmount: inputAmount,
        economicTradingAmount: economics?.economicTradingAmount ?? inputAmount,
        expectedOutputAmount: prepared.outputAmount, minimumOutputAmount: prepared.minimumOutputAmount,
        tradeeFee: prepared.platformFeeAmount, tradeeFeeBps: prepared.platformFeeBps,
        tradeeFeeAsset: this.configuration.usdcMint, slippageBps: prepared.slippageBps,
        priceImpact: prepared.priceImpact, executionRisk, quotedAt: this.now(),
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        providerReference: prepared.providerReference, executionMode: prepared.executionMode,
        route: prepared.route, transaction: prepared.transaction,
        transactionDigest: digestTransaction(prepared.transaction), requiredSigners: prepared.requiredSigners ?? [wallet.address],
      };
      return await this.orders.attachQuote(order.orderId, quote, this.now());
    } catch (error) {
      await this.orders.transition(order.orderId, TradeOrderState.FAILED, this.now(),
        error instanceof TradingEngineError ? error.code : "TRADE_PROVIDER_UNAVAILABLE");
      throw error;
    }
  }

  async prepareOrderAuthorization(
    request: PrepareTradeAuthorizationRequest,
  ): Promise<SponsoredTransactionAuthorizationChallenge> {
    let aggregate = await this.requireOwnedOrder(request.orderId, request.userId, request.walletAddress);
    if (aggregate.order.state !== TradeOrderState.AWAITING_SIGNATURE || aggregate.quote === null) {
      throw invalidState("Trade order is not awaiting Privy authorization.");
    }
    if (aggregate.quote.executionRisk.requiresAcknowledgement
      && (request.preparingOnly === true || !request.riskAcknowledged)
      && aggregate.order.riskAcknowledgedAt === null) {
      throw new TradingEngineError(
        "TRADE_RISK_ACKNOWLEDGEMENT_REQUIRED",
        "This order needs explicit confirmation because its estimated execution price may move materially.",
        true,
      );
    }
    if (aggregate.order.submissionClaimedAt !== null) {
      aggregate = await this.reconcilePrivyClaim(aggregate);
      if (aggregate.order.state !== TradeOrderState.AWAITING_SIGNATURE
        || aggregate.order.submissionClaimedAt !== null) {
        throw invalidState("Trade order submission is already being reconciled.");
      }
    }
    if (aggregate.quote === null) throw invalidState("Trade quote is missing.");
    if(aggregate.quote.feeQuote && this.now().getTime()-Date.parse(aggregate.quote.feeQuote.quotedAt)>15_000){
      const checked=await this.checkNetworkFee(request.orderId,request.userId,request.walletAddress,true);
      if(checked.refreshRequired)throw new TradingEngineError('TRADE_TRANSACTION_EXPIRED','Network fee quote expired. Please review the refreshed quote.',true);
    }

    const wallet = await this.requireExecutionWallet(aggregate);
    const policy = await this.policy.validateTrade({
      userId: aggregate.order.userId,
      wallet: { address: aggregate.order.walletAddress, chain: TradingChain.SOLANA },
      assetId: aggregate.order.assetId,
      side: aggregate.order.side,
      amount: aggregate.order.requestedAmount,
    });
    assertQuantitySnapshot(policy.asset, aggregate.quote, this.now());
    const [blockHeight, transaction] = await Promise.all([
      this.solana.getBlockHeight(),
      this.transactionValidator.validate(aggregate),
    ]);
    if (blockHeight > aggregate.quote.lastValidBlockHeight) {
      await this.orders.transition(
        aggregate.order.orderId,
        TradeOrderState.EXPIRED,
        this.now(),
        "TRADE_TRANSACTION_EXPIRED",
      );
      throw new TradingEngineError("TRADE_TRANSACTION_EXPIRED", "The trade transaction expired.", true);
    }
    const admission = { userId: aggregate.order.userId, walletId: wallet.providerWalletId, orderId: aggregate.order.orderId };
    const sponsorship = request.preparingOnly
      ? await this.sponsorshipPolicy.inspect?.(admission) ?? { eligible: false, reason: "disabled" as const }
      : await this.sponsorshipPolicy.evaluate(admission);
    if (!sponsorship.eligible) {
      const code = sponsorship.reason === "rate_limited" ? "TRADE_SPONSORSHIP_RATE_LIMITED"
        : sponsorship.reason === "wallet_not_supported" ? "TRADE_WALLET_EXECUTION_UNSUPPORTED"
          : "TRADE_GAS_SPONSORSHIP_REJECTED";
      throw new TradingEngineError(code, "This trade is not eligible for gas sponsorship.", true);
    }

    return this.sponsoredTransactions.createAuthorizationChallenge({
      feePayerContext: { userId: aggregate.order.userId, walletAddress: aggregate.order.walletAddress,
        operation: aggregate.order.side, lastValidBlockHeight: aggregate.quote.lastValidBlockHeight.toString(),
        ...(aggregate.quote.feeQuote?.benefits?.rentWaived ? {rentWaived:true} : {}) },
      walletId: wallet.providerWalletId,
      serializedTransaction: transaction.serializedTransaction,
      transactionDigest: transaction.transactionDigest,
      referenceId: privyReference(aggregate.order.orderId),
      idempotencyKey: `tradee-sponsor:${aggregate.order.orderId}`,
    });
  }

  async submitOrder(request: SubmitTradeRequest): Promise<TradeAggregate> {
    let aggregate = await this.requireOwnedOrder(request.orderId, request.userId, request.walletAddress);
    if (aggregate.order.state === TradeOrderState.SUBMITTED || aggregate.order.state === TradeOrderState.CONFIRMED) return aggregate;
    if (aggregate.order.state !== TradeOrderState.AWAITING_SIGNATURE || aggregate.quote === null) {
      throw invalidState("Trade order is not awaiting Privy authorization.");
    }
    if (aggregate.quote.executionRisk.requiresAcknowledgement
      && !request.riskAcknowledged
      && aggregate.order.riskAcknowledgedAt === null) {
      throw new TradingEngineError(
        "TRADE_RISK_ACKNOWLEDGEMENT_REQUIRED",
        "This order needs explicit confirmation because its estimated execution price may move materially.",
        true,
      );
    }
    if (aggregate.order.submissionClaimedAt !== null) {
      aggregate = await this.reconcilePrivyClaim(aggregate);
      if (aggregate.order.state !== TradeOrderState.AWAITING_SIGNATURE
        || aggregate.order.submissionClaimedAt !== null) return aggregate;
    }
    if (aggregate.quote === null) throw invalidState("Trade quote is missing.");

    if(aggregate.quote.feeQuote&&this.now().getTime()-Date.parse(aggregate.quote.feeQuote.quotedAt)>15_000){
      const checked=await this.checkNetworkFee(request.orderId,request.userId,request.walletAddress,true);
      if(checked.refreshRequired)throw new TradingEngineError('TRADE_TRANSACTION_EXPIRED','Network fee quote expired. Please review the refreshed quote.',true);
    }
    const wallet = await this.requireExecutionWallet(aggregate);
    const policy = await this.policy.validateTrade({
      userId: aggregate.order.userId,
      wallet: { address: aggregate.order.walletAddress, chain: TradingChain.SOLANA },
      assetId: aggregate.order.assetId, side: aggregate.order.side,
      amount: aggregate.order.requestedAmount,
    });
    assertQuantitySnapshot(policy.asset, aggregate.quote, this.now());
    const [blockHeight, transaction] = await Promise.all([
      this.solana.getBlockHeight(),
      this.transactionValidator.validate(aggregate),
    ]);
    if (blockHeight > aggregate.quote.lastValidBlockHeight) {
      return this.orders.transition(aggregate.order.orderId, TradeOrderState.EXPIRED, this.now(), "TRADE_TRANSACTION_EXPIRED");
    }
    const sponsorship = await this.sponsorshipPolicy.evaluate({
      userId: aggregate.order.userId, walletId: wallet.providerWalletId, orderId: aggregate.order.orderId,
    });
    if (!sponsorship.eligible) {
      const code = sponsorship.reason === "rate_limited" ? "TRADE_SPONSORSHIP_RATE_LIMITED"
        : sponsorship.reason === "wallet_not_supported" ? "TRADE_WALLET_EXECUTION_UNSUPPORTED"
          : "TRADE_GAS_SPONSORSHIP_REJECTED";
      throw new TradingEngineError(code, "This trade is not eligible for gas sponsorship.", true);
    }

    aggregate = await this.orders.claimSubmission(
      aggregate.order.orderId,
      aggregate.order.userId,
      transaction.transactionDigest,
      request.riskAcknowledged,
      this.now(),
    );
    if (aggregate.order.state === TradeOrderState.SUBMITTED || aggregate.order.state === TradeOrderState.CONFIRMED) return aggregate;
    let result: Awaited<ReturnType<SponsoredTransactionProvider["signAndSend"]>>;
    try {
      result = await this.sponsoredTransactions.signAndSend({
        feePayerContext: { userId: aggregate.order.userId, walletAddress: aggregate.order.walletAddress,
          operation: aggregate.order.side, lastValidBlockHeight: aggregate.quote!.lastValidBlockHeight.toString(),
          ...(aggregate.quote!.feeQuote?.benefits?.rentWaived ? {rentWaived:true} : {}) },
        walletId: wallet.providerWalletId,
        serializedTransaction: transaction.serializedTransaction,
        transactionDigest: transaction.transactionDigest,
        referenceId: privyReference(aggregate.order.orderId),
        idempotencyKey: `tradee-sponsor:${aggregate.order.orderId}`,
        ...(request.authorizationSignature === undefined
          ? {}
          : { authorizationSignature: request.authorizationSignature }),
        ...(request.authorizationRequestExpiry === undefined
          ? {}
          : { authorizationRequestExpiry: request.authorizationRequestExpiry }),
        ...(request.userAuthorizationToken === undefined
          ? {}
          : { userAuthorizationToken: request.userAuthorizationToken }),
      });
    } catch (error) {
      if (!isAmbiguous(error)) await this.orders.releaseSubmissionClaim(aggregate.order.orderId, aggregate.order.userId);
      throw error;
    }
    try {
      return await this.markSponsoredSubmitted(aggregate, result);
    } catch {
      // Privy has already accepted/broadcast the transaction. Releasing the claim here
      // could allow a second on-chain submission if the database write was the part
      // that failed. Keep the claim and recover by the stable Privy reference instead.
      const persisted = await this.orders.findById(aggregate.order.orderId).catch(() => null);
      if (persisted?.order.state === TradeOrderState.SUBMITTED
        || persisted?.order.state === TradeOrderState.CONFIRMED) return persisted;
      throw new TradingEngineError(
        "TRADE_SUBMISSION_AMBIGUOUS",
        "The transaction may have been submitted and is being reconciled.",
        true,
      );
    }
  }

  async confirmedPosition(orderId: string, userId: string, walletAddress: string) {
    const aggregate = await this.requireOwnedOrder(orderId, userId, walletAddress);
    if (aggregate.order.state !== TradeOrderState.CONFIRMED || !aggregate.execution) {
      throw invalidState("Position updates require a confirmed execution.");
    }
    return await this.confirmedReceipts?.positionUpdate?.(aggregate.execution.executionId, userId) ?? null;
  }

  async reconcileOrder(orderId: string, userId: string, walletAddress: string): Promise<TradeAggregate> {
    let aggregate = await this.requireOwnedOrder(orderId, userId, walletAddress);
    if (aggregate.order.state === TradeOrderState.AWAITING_SIGNATURE && aggregate.order.submissionClaimedAt !== null) {
      aggregate = await this.reconcilePrivyClaim(aggregate);
    }
    if (aggregate.order.state !== TradeOrderState.SUBMITTED) return aggregate;
    const signature = aggregate.execution?.transactionSignature;
    if (signature === null || signature === undefined || aggregate.quote === null) throw invalidState("Submitted trade is missing reconciliation data.");
    // A transient status failure must not disable the existing recovery path.
    let status = await this.solana.getTransactionStatus(signature).catch(() => null);
    let recovered = false;
    if (status === null) {
      await this.sponsoredTransactions.recoverSubmission?.(privyReference(orderId));
      recovered = true;
      status = await this.solana.getTransactionStatus(signature);
    }
    if (status.state === "confirmed") return this.confirmOrder(orderId);
    if (status.state === "failed") return this.orders.transition(orderId, TradeOrderState.FAILED, this.now(), "TRADE_CONFIRMATION_FAILED");
    // Terminal on-chain outcomes never wait for receipt enrichment/rebroadcast.
    if (!recovered) await this.sponsoredTransactions.recoverSubmission?.(privyReference(orderId));
    if (!await this.sponsoredTransactions.isDurablySigned?.(privyReference(orderId))
      && await this.solana.getBlockHeight() > aggregate.quote.lastValidBlockHeight) {
      return this.orders.transition(orderId, TradeOrderState.EXPIRED, this.now(), "TRADE_TRANSACTION_EXPIRED");
    }
    return aggregate;
  }

  async handleSponsoredTransactionEvent(event: SponsoredTransactionEvent): Promise<TradeAggregate | null> {
    let aggregate = await this.orders.findByPrivyReferenceId(event.referenceId);
    if (aggregate === null) return null;
    const wallet = await this.wallets.findOwnedSolanaWallet(aggregate.order.userId, aggregate.order.walletAddress);
    if (wallet?.providerWalletId !== event.walletId) throw new TradingEngineError("TRADE_WALLET_MISMATCH", "Privy webhook wallet does not match the trade.");
    if (aggregate.order.state === TradeOrderState.AWAITING_SIGNATURE && event.transactionSignature !== null) {
      if (aggregate.quote?.executionRisk.requiresAcknowledgement === true
        && aggregate.order.riskAcknowledgedAt === null) {
        throw new TradingEngineError(
          "TRADE_RISK_ACKNOWLEDGEMENT_REQUIRED",
          "A sponsored transaction cannot be accepted before the user confirms the execution-price warning.",
          true,
        );
      }
      if (aggregate.order.submissionClaimedAt === null) {
        if (aggregate.quote === null) throw invalidState("Trade quote is missing.");
        aggregate = await this.orders.claimSubmission(
          aggregate.order.orderId,
          aggregate.order.userId,
          aggregate.quote.transactionDigest,
          aggregate.order.riskAcknowledgedAt !== null,
          this.now(),
        );
      }
      aggregate = await this.markSponsoredSubmitted(aggregate, {
        transactionSignature: event.transactionSignature, providerTransactionId: event.providerTransactionId,
        referenceId: event.referenceId,
      });
    }
    if (event.type === "confirmed" && aggregate.order.state === TradeOrderState.SUBMITTED) {
      return this.confirmOrder(aggregate.order.orderId);
    }
    if (event.type === "failed" && (aggregate.order.state === TradeOrderState.AWAITING_SIGNATURE || aggregate.order.state === TradeOrderState.SUBMITTED)) {
      return this.orders.transition(aggregate.order.orderId, TradeOrderState.FAILED, this.now(), "TRADE_CONFIRMATION_FAILED");
    }
    return aggregate;
  }

  private async reconcilePrivyClaim(aggregate: TradeAggregate): Promise<TradeAggregate> {
    await this.sponsoredTransactions.recoverSubmission?.(privyReference(aggregate.order.orderId));
    const status = await this.sponsoredTransactions.getByReferenceId(privyReference(aggregate.order.orderId));
    if (status.state === "failed") return this.orders.transition(aggregate.order.orderId, TradeOrderState.FAILED, this.now(), "TRADE_SUBMISSION_FAILED");
    if (status.transactionSignature === null) {
      if (status.state !== "not_found") return aggregate;
      if (aggregate.quote === null) throw invalidState("Trade quote is missing.");
      if (await this.solana.getBlockHeight() > aggregate.quote.lastValidBlockHeight) {
        return this.orders.transition(
          aggregate.order.orderId,
          TradeOrderState.EXPIRED,
          this.now(),
          "TRADE_TRANSACTION_EXPIRED",
        );
      }
      const claimedAt = aggregate.order.submissionClaimedAt;
      if (claimedAt !== null
        && this.now().getTime() - claimedAt.getTime() >= this.configuration.submissionRecoveryDelayMs) {
        await this.orders.releaseSubmissionClaim(aggregate.order.orderId, aggregate.order.userId);
        const released = await this.orders.findById(aggregate.order.orderId);
        if (released === null) throw new TradingEngineError("TRADE_NOT_FOUND", "Trade order was not found.");
        return released;
      }
      return aggregate;
    }
    let submitted = await this.markSponsoredSubmitted(aggregate, {
      transactionSignature: status.transactionSignature, providerTransactionId: status.providerTransactionId,
      referenceId: status.referenceId,
    });
    if (status.state === "confirmed") submitted = await this.confirmOrder(submitted.order.orderId);
    return submitted;
  }

  private async confirmOrder(orderId: string): Promise<TradeAggregate> {
    const confirmed = await this.orders.transition(orderId, TradeOrderState.CONFIRMED, this.now());
    if (confirmed.execution && this.confirmedReceipts) {
      // Confirmation is already durable. Social receipt enrichment must not
      // delay Bought/Sold; Add Post retries capture if this process exits.
      const { executionId } = confirmed.execution;
      const { userId } = confirmed.order;
      void Promise.resolve().then(() => this.confirmedReceipts!.prepare(executionId, userId))
        .catch(() => { /* Add Post retries this optional enrichment. */ });
    }
    return confirmed;
  }

  private async markSponsoredSubmitted(
    aggregate: TradeAggregate,
    result: { transactionSignature: string; providerTransactionId: string | null; referenceId: string },
  ): Promise<TradeAggregate> {
    if (aggregate.quote === null) throw invalidState("Trade quote is missing.");
    assertTradeOrderTransition(TradeOrderState.AWAITING_SIGNATURE, TradeOrderState.SUBMITTED);
    const submittedAt = this.now();
    const execution: TradeExecution = {
      executionId: randomUUID(), orderId: aggregate.order.orderId,
      transactionSignature: result.transactionSignature,
      privyTransactionId: result.providerTransactionId, privyReferenceId: result.referenceId,
      gasSponsored: true, inputAmount: aggregate.quote.grossInputAmount,
      outputAmount: aggregate.quote.expectedOutputAmount, tradeeFee: aggregate.quote.tradeeFee,
      submittedAt, confirmedAt: null, failedAt: null, failureCode: null,
    };
    return this.orders.markSubmitted(aggregate.order.orderId, aggregate.order.userId, execution, submittedAt);
  }

  private async requireExecutionWallet(aggregate: TradeAggregate): Promise<TradingWalletRecord & { providerWalletId: string }> {
    const wallet = await this.wallets.findOwnedSolanaWallet(aggregate.order.userId, aggregate.order.walletAddress);
    if (wallet === null || wallet.id !== aggregate.order.walletId || wallet.providerWalletId === null || !wallet.teeExecutionEnabled) {
      throw new TradingEngineError("TRADE_WALLET_EXECUTION_UNSUPPORTED", "This Privy wallet is not configured for server-authorized TEE execution.");
    }
    return { ...wallet, providerWalletId: wallet.providerWalletId };
  }

  private normalizeSlippage(value: number | undefined): number {
    const slippage = value ?? this.configuration.defaultSlippageBps;
    if (!Number.isSafeInteger(slippage) || slippage < this.configuration.minimumSlippageBps || slippage > this.configuration.maximumSlippageBps) {
      throw new TradingEngineError("TRADE_INVALID_SLIPPAGE", "Requested slippage is outside the Tradee policy range.");
    }
    return slippage;
  }

  private assertMinimumSellGrossProceeds(grossProceeds: BaseUnitAmount): void {
    if (BigInt(grossProceeds) < BigInt(this.configuration.minimumSellGrossProceeds)) {
      throw new TradingEngineError(
        "TRADE_SELL_VALUE_BELOW_MINIMUM",
        "Sell value is below the configured minimum.",
        true,
      );
    }
  }

  async refreshNetworkFee(orderId:string,userId:string,walletAddress:string):Promise<{refreshRequired:boolean;quotedAt:string|null}>{
    return this.checkNetworkFee(orderId,userId,walletAddress,false);
  }

  private async checkNetworkFee(orderId:string,userId:string,walletAddress:string,reuse:boolean):Promise<{refreshRequired:boolean;quotedAt:string|null}>{
    const aggregate=await this.requireOwnedOrder(orderId,userId,walletAddress);
    const quote=aggregate.quote;
    if(aggregate.order.state!==TradeOrderState.AWAITING_SIGNATURE||aggregate.order.submissionClaimedAt!==null)throw invalidState('Order is not available for fee refresh.');
    if(!quote?.feeQuote||!this.chargedQuotes)return {refreshRequired:true,quotedAt:null};
    // Do not keep an old price/route alive indefinitely just because gas is stable.
    if(this.now().getTime()-quote.quotedAt.getTime()>45_000)return {refreshRequired:true,quotedAt:null};
    await this.policy.validateTrade({userId,wallet:{address:walletAddress,chain:TradingChain.SOLANA},assetId:aggregate.order.assetId,
      side:aggregate.order.side,amount:aggregate.order.requestedAmount});
    const gross=quote.side===TradingSide.BUY?BigInt(quote.grossInputAmount):BigInt(quote.expectedOutputAmount)+BigInt(quote.tradeeFee);
    return this.recentFeeValidations.check(aggregate,reuse,this.now,async()=>{
      const fresh=await this.chargedQuotes!.refresh(quote.transaction,quote.lastValidBlockHeight,quote.side,gross,quote.feeQuote!);
      return {refreshRequired:fresh===null,quotedAt:fresh?.quotedAt??null};
    });
  }

  private async requireOwnedOrder(orderId: string, userId: string, walletAddress: string): Promise<TradeAggregate> {
    const aggregate = await this.orders.findById(orderId);
    if (aggregate === null || aggregate.order.userId !== userId || aggregate.order.walletAddress !== walletAddress) {
      throw new TradingEngineError("TRADE_NOT_FOUND", "Trade order was not found.");
    }
    return aggregate;
  }
}

function requireSameRequest(order: TradeOrder, request: CreateTradeRequest): void {
  if (order.assetId !== request.assetId || order.side !== request.side || order.requestedAmount !== normalizedAmount(request.amount) || order.walletAddress !== request.walletAddress || (order.quantityUnit ?? 'TOKEN') !== (request.quantityUnit ?? 'TOKEN')) {
    throw new TradingEngineError("TRADE_IDEMPOTENCY_CONFLICT", "The idempotency key is already associated with a different trade request.");
  }
}
function normalizedAmount(value: string): string { try { return parseExactDecimal(value).value; } catch { return value; } }
function tradeAmountToBaseUnits(value: string, decimals: number, multiplier = '1'): BaseUnitAmount {
  try {
    return multiplier === '1' ? decimalToBaseUnits(value, decimals) : scaledQuantityToBaseUnits(value, decimals, multiplier);
  } catch (error) {
    if (error instanceof BaseUnitAmountError) {
      throw new TradingEngineError(
        "TRADE_INVALID_AMOUNT_PRECISION",
        multiplier === '1' ? `Trade amount cannot use more than ${decimals} fractional digits.` : 'Sell amount is smaller than one transferable token unit.',
        true,
      );
    }
    throw error;
  }
}
function privyReference(orderId: string): string { return `tradee:${orderId}`; }
function isAmbiguous(error: unknown): boolean { return error instanceof TradingEngineError && error.code === "TRADE_SUBMISSION_AMBIGUOUS"; }
function invalidState(message: string): TradingEngineError { return new TradingEngineError("TRADE_INVALID_STATE", message); }
