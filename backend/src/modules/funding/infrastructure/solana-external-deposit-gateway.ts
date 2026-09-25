import { ComputeBudgetProgram, Connection, PublicKey, SendTransactionError, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js';
import { ExternalDepositError, type ExternalDepositGateway, type ExternalDepositIntent } from '../domain/external-wallet-deposit.js';
import { decimalToBaseUnits } from '../../trading/domain/base-units.js';
import { LIGHTHOUSE_DEPOSIT_PROGRAM, validLighthouseDepositPayload } from './lighthouse-deposit-guard.js';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const EXTERNAL_DEPOSIT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const invalid = () => new ExternalDepositError('invalid_external_deposit', 'The deposit transaction does not match your confirmation.');

/** A deterministic, narrow USDC transfer. The external wallet pays network/ATA fees. */
export function externalDepositTransaction(intent: ExternalDepositIntent, blockhash: string): Transaction {
  try {
    if (intent.mint !== EXTERNAL_DEPOSIT_USDC || !/^(0|[1-9]\d{0,13})(\.\d{1,6})?$/.test(intent.amount)) throw invalid();
    const amount = BigInt(decimalToBaseUnits(intent.amount, 6));
    if (amount > 0xffffffffffffffffn) throw invalid();
    const source = new PublicKey(intent.sourceWallet);
    const destination = new PublicKey(intent.destinationWallet);
    const mint = new PublicKey(intent.mint);
    if (!PublicKey.isOnCurve(source.toBytes()) || source.equals(destination)) throw invalid();
    const tokenAccount = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
    const destinationToken = tokenAccount(destination);
    const create = new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [
      { pubkey: source, isSigner: true, isWritable: true },
      { pubkey: destinationToken, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ] });
    const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = 6;
    const transfer = new TransactionInstruction({ programId: TOKEN, data, keys: [
      { pubkey: tokenAccount(source), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destinationToken, isSigner: false, isWritable: true },
      { pubkey: source, isSigner: true, isWritable: false },
    ] });
    return new Transaction({ feePayer: source, recentBlockhash: blockhash }).add(create, transfer);
  } catch { throw invalid(); }
}

export function validateExternalDeposit(intent: ExternalDepositIntent, encoded: string): Transaction {
  try {
    if (encoded.length > 1800 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid();
    const raw = Buffer.from(encoded, 'base64');
    if (raw.toString('base64') !== encoded || raw.length > 1232 || raw.length <= 65 || raw[0] !== 1) throw invalid();
    const signed = Transaction.from(raw);
    const expected = externalDepositTransaction(intent, signed.recentBlockhash!);
    const budgetTags = new Set<number>();
    const transfers = signed.instructions.filter(instruction => {
      if (!instruction.programId.equals(ComputeBudgetProgram.programId)) return true;
      const tag = instruction.data[0];
      if (instruction.keys.length !== 0 || tag === undefined || budgetTags.has(tag)
        || !((tag === 2 && instruction.data.length === 5) || (tag === 3 && instruction.data.length === 9))) throw invalid();
      budgetTags.add(tag);
      return false;
    });
    const [creation, payment] = expected.instructions as [TransactionInstruction, TransactionInstruction];
    const sameAccounts = (actual: TransactionInstruction, reference: TransactionInstruction) =>
      actual.keys.length === reference.keys.length && actual.keys.every((key, index) => key.pubkey.equals(reference.keys[index]!.pubkey));
    let hasOriginalPayment = false; let creations = 0;
    for (const instruction of transfers) {
      if (instruction.programId.equals(TOKEN)) {
        if (!sameAccounts(instruction, payment) || instruction.data.length !== 10
          || instruction.data[0] !== 12 || instruction.data[9] !== 6 || instruction.data.readBigUInt64LE(1) === 0n) throw invalid();
        // The reviewed payment must still be present unchanged. Additional USDC
        // is allowed only to that same derived recipient ATA, from the same signer.
        hasOriginalPayment ||= instruction.data.equals(payment.data);
      } else if (instruction.programId.toBase58() === LIGHTHOUSE_DEPOSIT_PROGRAM) {
        const tokenTargets = [payment.keys[0]!.pubkey, payment.keys[2]!.pubkey];
        const targets = [9, 10].includes(instruction.data[0] ?? -1) ? tokenTargets
          : [...tokenTargets, expected.feePayer!, creation.keys[2]!.pubkey];
        if (instruction.keys.length !== 1 || !targets.some(key => key.equals(instruction.keys[0]!.pubkey))
          || !validLighthouseDepositPayload(instruction.data)) throw invalid();
      } else if (instruction.programId.equals(ATA)) {
        // Wallets may omit creation of an existing ATA or use Create instead of
        // CreateIdempotent. Older Create encodings include the readonly rent sysvar.
        const accounts = instruction.keys.length === 7 && instruction.keys[6]!.pubkey.equals(SYSVAR_RENT_PUBKEY)
          ? new TransactionInstruction({ ...instruction, keys: instruction.keys.slice(0, 6) }) : instruction;
        if (++creations !== 1 || !sameAccounts(accounts, creation)
          || !(instruction.data.length === 0 || (instruction.data.length === 1 && [0, 1].includes(instruction.data[0]!)))) throw invalid();
      } else {
        // No third-party sends, SOL transfers, approvals, closes or arbitrary CPI.
        throw invalid();
      }
    }
    if (!hasOriginalPayment) throw invalid();
    const actualMessage = signed.compileMessage();
    const expectedMessage = expected.compileMessage();
    if (actualMessage.header.numRequiredSignatures !== 1 || actualMessage.header.numReadonlySignedAccounts !== 0
      || !actualMessage.accountKeys[0]?.equals(expectedMessage.accountKeys[0]!)) throw invalid();
    const permissions = (message: typeof actualMessage) => new Map(message.accountKeys.map((key, index) => [
      key.toBase58(), `${message.isAccountSigner(index)}:${message.isAccountWritable(index)}`,
    ]));
    const actualPermissions = permissions(actualMessage); const expectedPermissions = permissions(expectedMessage);
    if (actualPermissions.size !== actualMessage.accountKeys.length) throw invalid();
    for (const [key, flags] of actualPermissions) {
      if (expectedPermissions.has(key)) {
        if (flags !== expectedPermissions.get(key)) throw invalid();
      } else if (![ComputeBudgetProgram.programId.toBase58(), SYSVAR_RENT_PUBKEY.toBase58(), LIGHTHOUSE_DEPOSIT_PROGRAM].includes(key) || flags !== 'false:false') throw invalid();
    }
    // Verify and broadcast the exact user-signed bytes; never strip the budget
    // instructions or rebuild the message after signing.
    if (!signed.serializeMessage().equals(raw.subarray(65)) || !signed.verifySignatures() || !signed.serialize().equals(raw)) throw invalid();
    return signed;
  } catch { throw invalid(); }
}

type RPC = Pick<Connection, 'getLatestBlockhash' | 'sendRawTransaction'>;
export class SolanaExternalDepositGateway implements ExternalDepositGateway {
  private readonly connections: readonly RPC[];
  constructor(urls: readonly string[], connections?: readonly RPC[]) {
    this.connections = connections ?? urls.map(url => new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) }));
  }
  async prepare(intent: ExternalDepositIntent) {
    // Validate before touching RPC; no balance/gas precheck and no sponsorship.
    externalDepositTransaction(intent, SystemProgram.programId.toBase58());
    for (const connection of this.connections) {
      try {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const transaction = externalDepositTransaction(intent, blockhash).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
        return { transaction };
      } catch (error) { if (error instanceof ExternalDepositError) throw error; }
    }
    throw new ExternalDepositError('external_deposit_unavailable', 'Unable to prepare the deposit. No transaction was sent.', 503);
  }
  async submit(intent: ExternalDepositIntent, encoded: string) {
    const signed = validateExternalDeposit(intent, encoded);
    const connection = this.connections[0];
    if (!connection) throw new ExternalDepositError('external_deposit_unavailable', 'Deposit service is unavailable.', 503);
    // Signature can be derived before sending, including an ambiguous transport result.
    const signature = encodeBase58(signed.signature!);
    try {
      await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
      return { signature, submission: 'submitted' as const };
    } catch (error) {
      if (error instanceof SendTransactionError && /already been processed|AlreadyProcessed/i.test(error.message)) {
        return { signature, submission: 'submitted' as const };
      }
      if (error instanceof SendTransactionError) throw new ExternalDepositError('external_deposit_rejected', 'The wallet transaction was rejected. Check the sending wallet for USDC and network fees.');
      // Never turn a transport timeout into a fresh transfer or a false failed/success state.
      return { signature, submission: 'unknown' as const };
    }
  }
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + Buffer.from(bytes).toString('hex')); let result = '';
  while (value > 0n) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}
