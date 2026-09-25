import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { TradingEngineError, type SponsoredTransactionAuthorizationRequest, type SponsoredTransactionProvider,
  type SponsoredTransactionRequest, type SponsoredTransactionResult, type SponsoredTransactionStatus } from "../../trading/domain/trading.js";
import { ambiguous, sameRequest, sponsorError, type FeePayerChain, type FeePayerJournal, type FeePayerLimits, type FeePayerRecord } from "./fee-payer-domain.js";
import { FeePayerSigner, encodeBase58, verifyWalletSignature } from "./fee-payer-signer.js";
import type { UserTransactionSigner } from "./privy-user-transaction-signer.js";
import { valueNativeFee, type NativeFeePriceSource } from "./fee-usd-valuation.js";

export class CoSignTransactionProvider implements SponsoredTransactionProvider {
  constructor(private readonly payer: string, private readonly signer: FeePayerSigner | null,
    private readonly userSigner: UserTransactionSigner, private readonly chain: FeePayerChain,
    private readonly journal: FeePayerJournal, private readonly limits: FeePayerLimits,
    private readonly validateSponsorInstructions: (tx: VersionedTransaction) => Promise<void>,
    private readonly expiryMs = 60_000, private readonly feePrice?: NativeFeePriceSource) {}

  owns(transaction: string): boolean {
    try { return VersionedTransaction.deserialize(Buffer.from(transaction, "base64")).message.staticAccountKeys[0]?.toBase58() === this.payer; }
    catch { throw sponsorError("The reviewed transaction is malformed."); }
  }
  private validate(request: SponsoredTransactionAuthorizationRequest): VersionedTransaction {
    const context = request.feePayerContext;
    if (!context || !context.userId || !/^[1-9][0-9]*$/.test(context.lastValidBlockHeight)
      || !["BUY", "SELL", "WITHDRAW"].includes(context.operation)) throw sponsorError("Verified transaction context is required for gas sponsorship.");
    const bytes = Buffer.from(request.serializedTransaction, "base64");
    if (bytes.length > 1232 || createHash("sha256").update(bytes).digest("hex") !== request.transactionDigest) throw sponsorError("The reviewed transaction digest changed.");
    let tx: VersionedTransaction;
    try { tx = VersionedTransaction.deserialize(bytes); } catch { throw sponsorError("The reviewed transaction is malformed."); }
    if (!this.owns(request.serializedTransaction) || tx.message.header.numRequiredSignatures !== 2
      || tx.message.staticAccountKeys[1]?.toBase58() !== context.walletAddress
      || tx.signatures.some(s => s.some(b => b !== 0))) throw sponsorError("The transaction must require exactly the gas payer and the authenticated user.");
    return tx;
  }
  private ceiling(request: SponsoredTransactionAuthorizationRequest) {
    return request.feePayerContext?.operation === "WITHDRAW"
      ? { network: this.limits.withdrawNetworkLamports, rent: this.limits.withdrawRentLamports }
      : { network: this.limits.swapNetworkLamports, rent: this.limits.swapRentLamports };
  }
  private async preflight(request: SponsoredTransactionAuthorizationRequest, transaction = request.serializedTransaction) {
    const result = await this.chain.preflight(transaction, this.payer, request.feePayerContext!.lastValidBlockHeight);
    const cap = this.ceiling(request), total = cap.network + cap.rent;
    if (result.networkFee > cap.network || result.estimatedDebit - result.networkFee > cap.rent
      || result.balance < total + this.limits.minimumBalanceLamports) {
      throw sponsorError("Gas or account-creation cost exceeds policy, or the gas wallet reserve is insufficient.");
    }
    return result;
  }
  async createAuthorizationChallenge(request: SponsoredTransactionAuthorizationRequest) {
    if (!this.signer) throw sponsorError("New co-sign authorizations are disabled.");
    await this.validateSponsorInstructions(this.validate(request));
    await this.preflight(request);
    const cap = this.ceiling(request);
    const record = await this.journal.prepare({ request, payer: this.payer, requestExpiry: Date.now() + this.expiryMs,
      reservedLamports: (cap.network + cap.rent).toString(), state: "PREPARED", signedTransaction: null, signature: null });
    if (record.state !== "PREPARED") throw ambiguous();
    if (record.requestExpiry <= Date.now()) throw authorizationError();
    return { payloadBase64: this.userSigner.challenge(request, record.requestExpiry), requestExpiry: record.requestExpiry };
  }
  async signAndSend(request: SponsoredTransactionRequest): Promise<SponsoredTransactionResult> {
    const original = this.validate(request);
    const record = await this.journal.get(request.referenceId);
    if (!record || !sameRequest(record.request, request) || record.payer !== this.payer) throw authorizationError();
    if (record.signature) return this.result(record); // Never obtain another user signature for a signed reference.
    if (!this.signer) throw sponsorError("New co-sign submissions are disabled.");
    const cap = this.ceiling(request);
    if (record.reservedLamports !== (cap.network + cap.rent).toString()) throw sponsorError("Gas policy changed. Request a fresh authorization before signing.");
    const auth = request.authorizationSignature;
    if (!auth || !/^[A-Za-z0-9+/]+={0,2}$/.test(auth) || Buffer.from(auth, "base64").length < 8
      || Buffer.from(auth, "base64").length > 256 || request.authorizationRequestExpiry !== record.requestExpiry
      || record.requestExpiry <= Date.now()) throw authorizationError();
    await this.validateSponsorInstructions(original);
    // Both reads precede signing. Price reporting is independent of preflight;
    // its freshness is still rechecked after the signed-message simulation.
    const readPrice = () => this.feePrice?.getPrice().catch(() => ({ status: "UNAVAILABLE" as const, price: null }))
      ?? Promise.resolve({ status: "UNCONFIGURED" as const, price: null });
    const [, price] = request.feePayerContext?.operation === "WITHDRAW"
      ? [await this.preflight(request), await readPrice()] as const
      : await Promise.all([this.preflight(request), readPrice()]);
    const userSigned = await this.userSigner.sign(record.request, record.requestExpiry, auth);
    let tx: VersionedTransaction;
    try { tx = VersionedTransaction.deserialize(Buffer.from(userSigned, "base64")); } catch { throw authorizationError(); }
    if (!Buffer.from(tx.message.serialize()).equals(Buffer.from(original.message.serialize())) || !verifyWalletSignature(tx, 1)
      || tx.signatures[0]!.some(b => b !== 0)) throw authorizationError();
    this.signer.sign(tx);
    const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
    const estimate = await this.preflight(request, signedTransaction);
    const feeValuation = valueNativeFee(price, estimate.networkFee, estimate.estimatedDebit);
    let signed: FeePayerRecord;
    try { signed = await this.journal.commitSigned({ ...record, state: "SIGNED", signedTransaction, signature: encodeBase58(tx.signatures[0]!), feeValuation }, this.limits,
      async () => request.feePayerContext?.operation === "WITHDRAW"
        ? (await this.preflight(request, signedTransaction)).balance
        : this.chain.balance(this.payer, request.feePayerContext!.lastValidBlockHeight)); }
    catch (error) { if (error instanceof TradingEngineError) throw error; throw ambiguous(); }
    // Commit outcome can be ambiguous. No broadcast is attempted unless durable bytes were acknowledged.
    try { if (await this.chain.broadcast(signed.signedTransaction!) !== signed.signature) throw new Error(); }
    catch { throw ambiguous(); }
    return this.result(signed);
  }
  private result(record: FeePayerRecord): SponsoredTransactionResult {
    return { transactionSignature: record.signature!, providerTransactionId: null, referenceId: record.request.referenceId, sponsored: true };
  }
  async getByReferenceId(referenceId: string): Promise<SponsoredTransactionStatus> {
    const record = await this.journal.get(referenceId);
    if (!record?.signature) return { referenceId,
      state: record && record.requestExpiry > Date.now() ? "pending" : "not_found", transactionSignature: null, providerTransactionId: null };
    const status = record.state === "CONFIRMED" ? { state: "confirmed" as const } : record.state === "FAILED" ? { state: "failed" as const }
      : await this.chain.status(record.signature, record.payer);
    if ("fee" in status && status.fee !== undefined && status.debit !== undefined && status.state !== "pending") {
      await this.journal.settle(referenceId, status.state === "confirmed" ? "CONFIRMED" : "FAILED", status.fee, status.debit);
    }
    return { referenceId, state: status.state, transactionSignature: record.signature, providerTransactionId: null };
  }
  async recoverSubmission(referenceId: string): Promise<void> {
    const record = await this.journal.get(referenceId);
    if (!record?.signature || !record.signedTransaction || record.state !== "SIGNED") return;
    if ((await this.getByReferenceId(referenceId)).state !== "pending") return;
    // Unknown expired outcomes remain reserved for reconciliation; never manufacture a replacement signature.
    if (await this.chain.blockHeight() > BigInt(record.request.feePayerContext!.lastValidBlockHeight)) return;
    try { await this.chain.broadcast(record.signedTransaction); } catch { /* status is authoritative, not RPC acknowledgement */ }
  }
  async isDurablySigned(referenceId: string): Promise<boolean> { return Boolean((await this.journal.get(referenceId))?.signature); }
}
function authorizationError() { return new TradingEngineError("TRADE_USER_AUTHORIZATION_INVALID", "The user signature is missing, expired, or does not match the reviewed transaction.", true); }

/** Legacy requests stay on Privy sponsorship; an own-payer failure never falls back. */
export class RoutedSponsoredTransactionProvider implements SponsoredTransactionProvider {
  constructor(private readonly legacy: SponsoredTransactionProvider, private readonly own: CoSignTransactionProvider, private readonly journal: FeePayerJournal) {}
  createAuthorizationChallenge(request: SponsoredTransactionAuthorizationRequest) { return (this.own.owns(request.serializedTransaction) ? this.own : this.legacy).createAuthorizationChallenge(request); }
  signAndSend(request: SponsoredTransactionRequest) { return (this.own.owns(request.serializedTransaction) ? this.own : this.legacy).signAndSend(request); }
  async getByReferenceId(referenceId: string) { return await this.journal.get(referenceId) ? this.own.getByReferenceId(referenceId) : this.legacy.getByReferenceId(referenceId); }
  async recoverSubmission(referenceId: string) { if (await this.journal.get(referenceId)) await this.own.recoverSubmission(referenceId); }
  async isDurablySigned(referenceId: string) { return this.own.isDurablySigned(referenceId); }
}
