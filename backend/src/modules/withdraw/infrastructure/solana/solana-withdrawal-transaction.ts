import { createHash } from "node:crypto";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { decimalToBaseUnits, type BaseUnitAmount } from "../../../trading/domain/base-units.js";
import {
  WithdrawError,
  type PreparedWithdrawalTransaction,
  type Withdrawal,
  type WithdrawalAddressValidator,
  type WithdrawalTransactionBuilder,
  type WithdrawalTransactionValidator,
} from "../../domain/withdraw.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export class SolanaWithdrawalAddressValidator implements WithdrawalAddressValidator {
  canonicalize(value: string): string {
    try {
      const canonical = new PublicKey(value.trim()).toBase58();
      if (canonical.length < 32 || canonical.length > 44) throw new Error("invalid length");
      return canonical;
    } catch {
      throw new WithdrawError("WITHDRAW_INVALID_DESTINATION", "Enter a valid Solana wallet address.");
    }
  }
}

export class SolanaWithdrawalTransactionBuilder implements WithdrawalTransactionBuilder {
  private readonly connection: Connection;
  private readonly connections: readonly Connection[];
  private readonly latestBlockhash: () => Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: number }>;

  constructor(
    rpcURL: string | readonly string[],
    latestBlockhash?: () => Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: number }>,
    private readonly feePayerAddress?: string,
  ) {
    const urls = typeof rpcURL === "string" ? [rpcURL] : rpcURL;
    if (!urls.length) throw new Error("Withdrawal RPC endpoints are required.");
    this.connections = urls.map(url => new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }) }));
    this.connection = this.connections[0]!;
    this.latestBlockhash = latestBlockhash ?? (() => this.read(connection => connection.getLatestBlockhash("confirmed")));
  }

  private async read<T>(operation: (connection: Connection) => Promise<T>): Promise<T> {
    for (const connection of this.connections) { try { return await operation(connection); } catch { /* next RPC */ } }
    throw new WithdrawError("WITHDRAW_SPONSORSHIP_FAILED", "Withdrawal RPC is temporarily unavailable; no transaction was sent.", 503, true);
  }

  async prepare(input: {
    readonly sourceWallet: string;
    readonly destinationWallet: string;
    readonly mint: string;
    readonly amount: BaseUnitAmount;
    readonly decimals: number;
    readonly tradeeWithdrawalFee?: string;
    readonly feeTokenAccount?: string | null;
  }): Promise<PreparedWithdrawalTransaction> {
    let source: PublicKey;
    let destinationOwner: PublicKey;
    let mint: PublicKey;
    try {
      source = new PublicKey(input.sourceWallet);
      destinationOwner = new PublicKey(input.destinationWallet);
      mint = new PublicKey(input.mint);
    } catch {
      throw new WithdrawError("WITHDRAW_INVALID_DESTINATION", "Withdrawal contains an invalid Solana address.");
    }
    const sourceToken = associatedTokenAddress(source, mint);
    const payer = this.feePayerAddress ? new PublicKey(this.feePayerAddress) : source;
    const destinationToken = associatedTokenAddress(destinationOwner, mint);
    const createDestination = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: destinationToken, isSigner: false, isWritable: true },
        { pubkey: destinationOwner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // create associated token account idempotently
    });
    const fee = withdrawalFeeUnits(input.tradeeWithdrawalFee ?? "0", input.decimals);
    
    if (BigInt(input.amount) <= fee) throw mismatch("Withdrawal amount must exceed fee.");
    if (fee > 0n && !input.feeTokenAccount) throw mismatch("Treasury USDC account is required.");
    const treasuryKey = fee > 0n ? new PublicKey(input.feeTokenAccount!) : null;
    // Independent reads: don't wait for treasury validation before fetching a
    // blockhash. Both must succeed before the unsigned message is returned.
    const [blockhash, treasuryAccount] = await Promise.all([
      this.latestBlockhash(),
      treasuryKey ? this.read(connection => connection.getAccountInfo(treasuryKey, "confirmed")) : Promise.resolve(null),
    ]);
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(BigInt(input.amount) - fee);
    const transferChecked = new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [
        { pubkey: sourceToken, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destinationToken, isSigner: false, isWritable: true },
        { pubkey: source, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([12]), amount, Buffer.from([input.decimals])]),
    });
    const instructions = [createDestination, transferChecked];
    if (fee > 0n) {
      if (!input.feeTokenAccount) throw mismatch("Treasury USDC account is required.");
      const treasury = new PublicKey(input.feeTokenAccount);
      const account = treasuryAccount;
      if (!account || !account.owner.equals(TOKEN_PROGRAM) || account.data.length !== 165
        || !new PublicKey(account.data.subarray(0, 32)).equals(mint) || account.data[108] !== 1
        || new PublicKey(account.data.subarray(32, 64)).equals(source) || treasury.equals(sourceToken)) throw mismatch("Treasury must be an initialized external USDC token account.");
      const feeData = Buffer.alloc(8); feeData.writeBigUInt64LE(fee);
      instructions.push(new TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [
          { pubkey: sourceToken, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: treasury, isSigner: false, isWritable: true },
          { pubkey: source, isSigner: true, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([12]), feeData, Buffer.from([input.decimals])]),
      }));
    }
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash.blockhash,
      instructions,
    }).compileToV0Message();
    const serializedTransaction = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
    return {
      serializedTransaction,
      transactionDigest: withdrawalDigest(serializedTransaction),
      lastValidBlockHeight: BigInt(blockhash.lastValidBlockHeight),
    };
  }
}

export class SolanaWithdrawalTransactionValidator implements WithdrawalTransactionValidator {
  constructor(private readonly decimals: number, private readonly feePayerAddress?: string) {}

  async validate(withdrawal: Withdrawal): Promise<PreparedWithdrawalTransaction> {
    if (
      withdrawal.serializedTransaction === null
      || withdrawal.transactionDigest === null
      || withdrawal.lastValidBlockHeight === null
    ) throw mismatch("Prepared withdrawal transaction is missing.");
    if (withdrawalDigest(withdrawal.serializedTransaction) !== withdrawal.transactionDigest) {
      throw mismatch("Prepared withdrawal transaction digest changed after review.");
    }
    let transaction: VersionedTransaction;
    let source: PublicKey;
    let destinationOwner: PublicKey;
    let mint: PublicKey;
    try {
      transaction = VersionedTransaction.deserialize(Buffer.from(withdrawal.serializedTransaction, "base64"));
      source = new PublicKey(withdrawal.walletAddress);
      destinationOwner = new PublicKey(withdrawal.destinationAddress);
      mint = new PublicKey(withdrawal.mint);
    } catch { throw mismatch("Prepared withdrawal transaction is malformed."); }
    const message = transaction.message;
    if (message.addressTableLookups.length !== 0) throw mismatch("Withdrawal must not use unreviewed address lookup tables.");
    const keys = message.staticAccountKeys;
    const ownPayer = this.feePayerAddress !== undefined && keys[0]?.toBase58() === this.feePayerAddress;
    if (ownPayer ? (message.header.numRequiredSignatures !== 2 || !keys[1]?.equals(source))
      : (message.header.numRequiredSignatures !== 1 || !keys[0]?.equals(source))) {
      throw new WithdrawError("WITHDRAW_WALLET_MISMATCH", "Withdrawal does not require the authenticated Privy wallet.");
    }
    const fee = withdrawalFeeUnits(withdrawal.tradeeWithdrawalFee, this.decimals);
    
    if (BigInt(withdrawal.amountBaseUnits) <= fee) throw mismatch("Withdrawal amount must exceed fee.");
    if (message.compiledInstructions.length !== (fee > 0n ? 3 : 2)) throw mismatch("Withdrawal contains unexpected instructions.");
    const sourceToken = associatedTokenAddress(source, mint);
    const destinationToken = associatedTokenAddress(destinationOwner, mint);
    const create = message.compiledInstructions[0];
    const transfer = message.compiledInstructions[1];
    if (create === undefined || transfer === undefined) throw mismatch("Withdrawal instructions are missing.");
    if (!keys[create.programIdIndex]?.equals(ASSOCIATED_TOKEN_PROGRAM)) throw mismatch("Unexpected withdrawal program.");
    const createKeys = create.accountKeyIndexes.map((index) => keys[index]);
    const expectedCreate = [keys[0]!, destinationToken, destinationOwner, mint, SystemProgram.programId, TOKEN_PROGRAM];
    if (create.data.length !== 1 || create.data[0] !== 1 || !sameKeys(createKeys, expectedCreate)) {
      throw mismatch("Destination token account instruction does not match the approved wallet.");
    }
    if (!keys[transfer.programIdIndex]?.equals(TOKEN_PROGRAM)) throw mismatch("Unexpected token transfer program.");
    const transferKeys = transfer.accountKeyIndexes.map((index) => keys[index]);
    if (!sameKeys(transferKeys, [sourceToken, mint, destinationToken, source])) {
      throw mismatch("USDC source or destination changed after review.");
    }
    const data = Buffer.from(transfer.data);
    if (
      data.length !== 10
      || data[0] !== 12
      || data.readBigUInt64LE(1) !== BigInt(withdrawal.amountBaseUnits) - fee
      || data[9] !== this.decimals
    ) throw mismatch("USDC amount or precision changed after review.");
    if (fee > 0n) {
      if (!withdrawal.feeTokenAccount) throw mismatch("Missing treasury account.");
      const treasury = new PublicKey(withdrawal.feeTokenAccount);
      const instruction = message.compiledInstructions[2]!;
      const feeData = Buffer.from(instruction.data);
      if (treasury.equals(sourceToken) || !keys[instruction.programIdIndex]?.equals(TOKEN_PROGRAM)
        || !sameKeys(instruction.accountKeyIndexes.map(index => keys[index]), [sourceToken, mint, treasury, source])
        || feeData.length !== 10 || feeData[0] !== 12 || feeData.readBigUInt64LE(1) !== fee
        || feeData[9] !== this.decimals) throw mismatch("Treasury fee transfer changed after review.");
    }
    return {
      serializedTransaction: withdrawal.serializedTransaction,
      transactionDigest: withdrawal.transactionDigest,
      lastValidBlockHeight: withdrawal.lastValidBlockHeight,
    };
  }
}

export function withdrawalDigest(serializedTransaction: string): string {
  return createHash("sha256").update(Buffer.from(serializedTransaction, "base64")).digest("hex");
}

function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

function withdrawalFeeUnits(value: string, decimals: number): bigint {
  if (value === "0") return 0n;
  if (decimals !== 6) throw mismatch("Solana USDC requires six decimals.");
  const units = BigInt(decimalToBaseUnits(value, decimals));
  // The persisted review snapshot binds the fee; current Admin settings cannot rewrite it.
  if (units <= 0n || units > 18446744073709551615n) throw mismatch("Invalid reviewed withdrawal fee.");
  return units;
}

function sameKeys(actual: readonly (PublicKey | undefined)[], expected: readonly PublicKey[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value?.equals(expected[index]!) === true);
}
function mismatch(message: string): WithdrawError {
  return new WithdrawError("WITHDRAW_TRANSACTION_MISMATCH", message, 422);
}
