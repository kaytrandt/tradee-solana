import { createHash } from "node:crypto";
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import { TradingSide } from "../../transaction-policy/domain/trading-policy.js";
import { addBaseUnits } from "../domain/base-units.js";
import {
  TradingEngineError,
  type TradeAggregate,
} from "../domain/trading.js";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export interface SolanaLookupTableResolver {
  resolve(addresses: readonly string[]): Promise<readonly AddressLookupTableAccount[]>;
}

export interface TransactionValidationConfiguration {
  readonly allowedProgramIds: ReadonlySet<string>;
  readonly allowedDestinationAccounts: ReadonlySet<string>;
  readonly feeAccountUsdc: string;
}

export interface ValidatedTradeTransaction {
  readonly serializedTransaction: string;
  readonly transactionDigest: string;
  readonly programIds: readonly string[];
}

export interface TradeEconomicsVerifier {
  validate(aggregate: TradeAggregate, transaction: VersionedTransaction, tables: readonly AddressLookupTableAccount[]): Promise<void>;
}

export class SolanaTradeTransactionValidator {
  constructor(
    private readonly lookups: SolanaLookupTableResolver,
    private readonly configuration: TransactionValidationConfiguration,
    private readonly economics?: TradeEconomicsVerifier,
  ) {}

  async validate(aggregate: TradeAggregate): Promise<ValidatedTradeTransaction> {
    return this.validatePrepared(aggregate, true);
  }

  async validateFeeFreeSwap(aggregate: TradeAggregate): Promise<ValidatedTradeTransaction> {
    if(aggregate.quote?.tradeeFee !== '0' || aggregate.quote.tradeeFeeBps !== 0) {
      throw invalid('TRADE_FEE_MISMATCH','Asset migrations must not charge a Tradee platform fee.');
    }
    return this.validatePrepared(aggregate, false);
  }

  private async validatePrepared(aggregate: TradeAggregate, requireFeeDestination: boolean): Promise<ValidatedTradeTransaction> {
    const quote = aggregate.quote;
    if (quote === null) throw invalid("TRADE_TRANSACTION_MISMATCH", "Trade quote is missing.");
    verifyEconomics(aggregate);

    let transaction: VersionedTransaction;
    try {
      transaction = VersionedTransaction.deserialize(Buffer.from(quote.transaction, "base64"));
    } catch {
      throw invalid("TRADE_TRANSACTION_MISMATCH", "The prepared Solana transaction is invalid.");
    }
    const digest = digestTransaction(quote.transaction);
    if (digest !== quote.transactionDigest) {
      throw invalid("TRADE_TRANSACTION_MISMATCH", "The transaction no longer matches its approved quote.");
    }

    const message = transaction.message;
    const lookupAddresses = message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58());
    let lookupAccounts: readonly AddressLookupTableAccount[];
    try {
      lookupAccounts = await this.lookups.resolve(lookupAddresses);
    } catch {
      throw invalid("TRADE_TRANSACTION_MISMATCH", "A Solana address lookup table could not be resolved.");
    }
    if (lookupAccounts.length !== lookupAddresses.length) {
      throw invalid("TRADE_TRANSACTION_MISMATCH", "A Solana address lookup table could not be resolved.");
    }
    const accountKeys = message.getAccountKeys({ addressLookupTableAccounts: [...lookupAccounts] });
    const allKeys: string[] = [];
    for (let index = 0; index < accountKeys.length; index += 1) {
      const key = accountKeys.get(index);
      if (key === undefined) throw invalid("TRADE_TRANSACTION_MISMATCH", "A transaction account is invalid.");
      allKeys.push(key.toBase58());
    }

    const signerKeys = message.staticAccountKeys
      .slice(0, message.header.numRequiredSignatures)
      .map((key) => key.toBase58());
    if (!signerKeys.includes(aggregate.order.walletAddress)) {
      throw invalid("TRADE_WALLET_MISMATCH", "The transaction does not require the authenticated wallet.");
    }
    const accountSet = new Set(allKeys);
    if (
      !referencesUserAsset(accountSet, aggregate.order.walletAddress, quote.inputMint)
      || !referencesUserAsset(accountSet, aggregate.order.walletAddress, quote.outputMint)
    ) {
      throw invalid("TRADE_MINT_MISMATCH", "The transaction assets do not match the approved trade.");
    }
    if (requireFeeDestination && !allKeys.includes(this.configuration.feeAccountUsdc)) {
      throw invalid("TRADE_DESTINATION_NOT_ALLOWED", "The approved Tradee fee destination is missing.");
    }

    const programIds: string[] = [];
    const userTokenAccounts = new Set<string>();
    for (const mint of [quote.inputMint, quote.outputMint]) {
      for (const tokenProgram of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
        userTokenAccounts.add(PublicKey.findProgramAddressSync([
          new PublicKey(aggregate.order.walletAddress).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer(),
        ], new PublicKey(ASSOCIATED_TOKEN_PROGRAM))[0].toBase58());
      }
    }
    for (const compiled of message.compiledInstructions) {
      const program = accountKeys.get(compiled.programIdIndex);
      if (program === undefined) throw invalid("TRADE_TRANSACTION_MISMATCH", "A transaction program is invalid.");
      const programId = program.toBase58();
      programIds.push(programId);
      if (!this.configuration.allowedProgramIds.has(programId)) {
        throw invalid("TRADE_PROGRAM_NOT_ALLOWED", "The transaction contains a program that Tradee has not approved.");
      }
      validateDirectDestination(
        programId,
        compiled.accountKeyIndexes.map((index) => accountKeys.get(index)),
        Buffer.from(compiled.data),
        aggregate.order.walletAddress,
        userTokenAccounts,
        new Set([
          this.configuration.feeAccountUsdc,
          ...this.configuration.allowedDestinationAccounts,
        ]),
      );
    }

    if (this.economics) await this.economics.validate(aggregate, transaction, lookupAccounts);
    return {
      serializedTransaction: quote.transaction,
      transactionDigest: digest,
      programIds: [...new Set(programIds)],
    };
  }
}

function referencesUserAsset(
  accounts: ReadonlySet<string>,
  walletAddress: string,
  mintAddress: string,
): boolean {
  if (accounts.has(mintAddress)) return true;
  try {
    const owner = new PublicKey(walletAddress);
    const mint = new PublicKey(mintAddress);
    const associatedTokenProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);
    return [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM].some((programAddress) => {
      const tokenProgram = new PublicKey(programAddress);
      const [associatedTokenAccount] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
        associatedTokenProgram,
      );
      return accounts.has(associatedTokenAccount.toBase58());
    });
  } catch {
    return false;
  }
}

export function digestTransaction(serializedTransaction: string): string {
  return createHash("sha256")
    .update(Buffer.from(serializedTransaction, "base64"))
    .digest("hex");
}

function verifyEconomics(aggregate: TradeAggregate): void {
  const quote = aggregate.quote;
  if (quote === null) return;
  if (quote.assetId !== aggregate.order.assetId || quote.side !== aggregate.order.side) {
    throw invalid("TRADE_TRANSACTION_MISMATCH", "The quote is not bound to this order.");
  }
  const expectedFeeAsset = quote.side === TradingSide.BUY ? quote.inputMint : quote.outputMint;
  if (quote.tradeeFeeAsset !== expectedFeeAsset) {
    throw invalid("TRADE_FEE_MISMATCH", "The Tradee fee asset is invalid.");
  }
  if (
    quote.side === TradingSide.BUY
    && addBaseUnits(quote.economicTradingAmount, quote.tradeeFee) !== quote.grossInputAmount
  ) {
    throw invalid("TRADE_FEE_MISMATCH", "The BUY fee would exceed the authorized gross debit.");
  }
}

function validateDirectDestination(
  programId: string,
  accounts: readonly (PublicKey | undefined)[],
  data: Buffer,
  userWallet: string,
  userTokenAccounts: ReadonlySet<string>,
  allowedDestinations: ReadonlySet<string>,
): void {
  let destinationIndex: number | null = null;
  let sourceIndex: number | null = null;
  let authorityIndex: number | null = null;
  if (programId === SystemProgram.programId.toBase58() && data.length >= 4 && data.readUInt32LE(0) === 2) {
    sourceIndex = 0;
    destinationIndex = 1;
  } else if ((programId === SPL_TOKEN_PROGRAM || programId === SPL_TOKEN_2022_PROGRAM) && data.length >= 1) {
    if (data[0] === 3) {
      sourceIndex = 0;
      destinationIndex = 1;
      authorityIndex = 2;
    } else if (data[0] === 12) {
      sourceIndex = 0;
      destinationIndex = 2;
      authorityIndex = 3;
    } else {
      // Top-level approval/authority/close instructions are not swap consent.
      throw invalid("TRADE_PROGRAM_NOT_ALLOWED", "This token instruction has not been approved for trading.");
    }
  }
  if (destinationIndex === null || sourceIndex === null) return;
  const source = accounts[sourceIndex]?.toBase58();
  const destination = accounts[destinationIndex]?.toBase58();
  if (source === undefined || destination === undefined) {
    throw invalid("TRADE_TRANSACTION_MISMATCH", "A direct transfer instruction is malformed.");
  }
  const spendsUserAssets = source === userWallet || userTokenAccounts.has(source)
    || (authorityIndex !== null && accounts[authorityIndex]?.toBase58() === userWallet);
  if (spendsUserAssets && !allowedDestinations.has(destination)) {
    throw invalid("TRADE_DESTINATION_NOT_ALLOWED", "The transaction sends user assets to an unapproved destination.");
  }
}

function invalid(code: TradingEngineError["code"], message: string): TradingEngineError {
  return new TradingEngineError(code, message);
}
