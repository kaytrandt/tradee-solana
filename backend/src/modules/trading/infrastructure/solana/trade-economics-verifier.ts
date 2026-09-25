import { Connection, PublicKey, TransactionMessage, type VersionedTransaction, type AddressLookupTableAccount, type AccountInfo } from '@solana/web3.js';
import type { TradeEconomicsVerifier } from '../../application/solana-trade-transaction-validator.js';
import { TradingEngineError, type TradeAggregate } from '../../domain/trading.js';
import { validateDflowSwapConstraints } from '../dflow/dflow-swap-constraints.js';
import { isBuyDebitWithinBudget } from '../../domain/buy-input-budget.js';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ROUTER = 'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH';

/** Defense in depth for the exact message used at both prepare and submit.
 * Simulation is NOT proof of future router behavior; its limitations are documented
 * in the security audit. Never replace the immutable message/digest checks with it.
 */
export class SolanaTradeEconomicsVerifier implements TradeEconomicsVerifier {
  constructor(private readonly rpc: Connection, private readonly feeAccount: string,
    private readonly payer: string, private readonly usdcMint: string, private readonly decimals: number) {}

  async validate(aggregate: TradeAggregate, tx: VersionedTransaction, tables: readonly AddressLookupTableAccount[]): Promise<void> {
    const quote = aggregate.quote;
    if (!quote) throw invalid();
    const wallet = new PublicKey(aggregate.order.walletAddress);
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58());
    if (signers.length !== 2 || signers[0] !== this.payer || signers[1] !== wallet.toBase58()
      || tx.signatures.some(s => s.some(b => b !== 0)) || quote.tradeeFeeAsset !== this.usdcMint) throw invalid();
    const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [...tables] });
    const source = ata(wallet, new PublicKey(this.usdcMint), new PublicKey(TOKEN));
    let fees = 0, swaps = 0;
    for (const ix of message.instructions) {
      const program = ix.programId.toBase58();
      if ([TOKEN, TOKEN22].includes(program)) {
        if (program !== TOKEN || ix.keys.length !== 4 || ix.data.length !== 10 || ix.data[0] !== 12
          || ix.data[9] !== this.decimals || ix.data.readBigUInt64LE(1) !== BigInt(quote.tradeeFee)
          || !ix.keys[0]?.pubkey.equals(source) || ix.keys[1]?.pubkey.toBase58() !== this.usdcMint
          || ix.keys[2]?.pubkey.toBase58() !== this.feeAccount || !ix.keys[3]?.pubkey.equals(wallet)) throw invalid();
        fees++;
      } else if (program === ROUTER) {
        if (!ix.data.subarray(0, 8).equals(Buffer.from([248,198,158,145,225,117,135,200]))
          || !ix.keys[3]?.pubkey.equals(wallet)) throw invalid();
        validateDflowSwapConstraints(ix.data, quote);
        swaps++;
      } else if (program === PublicKey.default.toBase58()) {
        // A sponsored token trade has no reason to transfer or assign user SOL.
        throw invalid();
      } else if (program === ATA.toBase58()) {
        if (ix.data.length > 1 || (ix.data.length === 1 && ![0,1].includes(ix.data[0]!))
          || ix.keys[0]?.pubkey.toBase58() !== this.payer || !ix.keys[2]?.pubkey.equals(wallet)) throw invalid();
      } else if (program !== 'ComputeBudget111111111111111111111111111111') throw invalid();
    }
    if (fees !== 1 || swaps !== 1) throw invalid();
    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: [...tables] });
    const mintInfo = await this.rpc.getMultipleAccountsInfo([new PublicKey(quote.inputMint), new PublicKey(quote.outputMint)], 'confirmed');
    if (mintInfo.some(info => !info || ![TOKEN, TOKEN22].includes(info.owner.toBase58()))) throw invalid();
    const watched = [wallet, ata(wallet, new PublicKey(quote.inputMint), mintInfo[0]!.owner),
      ata(wallet, new PublicKey(quote.outputMint), mintInfo[1]!.owner)];
    for (let i = 0; i < keys.length; i++) {
      const key = keys.get(i)!;
      if (tx.message.isAccountWritable(i) && !watched.some(k => k.equals(key))) watched.push(key);
    }
    if (watched.length > 100) throw invalid();
    const before = await this.rpc.getMultipleAccountsInfoAndContext(watched, 'confirmed');
    const simulation = await this.rpc.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed',
      minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: watched.map(k => k.toBase58()) } });
    if (simulation.value.err || simulation.value.accounts?.length !== watched.length) throw invalid();
    const after = simulation.value.accounts.map(a => a ? { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0] as string, 'base64') } : null);
    verifyTradeBalanceChanges(aggregate, before.value, after);
  }
}

export function tradeEconomicsVerifier(url: string, feeAccount: string, payer: string, mint: string, decimals: number) {
  return new SolanaTradeEconomicsVerifier(new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }) }), feeAccount, payer, mint, decimals);
}

export function verifyTradeBalanceChanges(aggregate: TradeAggregate, before: readonly (AccountInfo<Buffer> | null)[], after: readonly (AccountInfo<Buffer> | null)[]): void {
  const q = aggregate.quote!;
  const wallet = aggregate.order.walletAddress;
  const oldSol = before[0] ?? null, nextSol = after[0] ?? null;
  // An embedded wallet with zero SOL need not have a System account at all.
  if (before.length !== after.length || !Number.isSafeInteger(oldSol?.lamports ?? 0)
    || !Number.isSafeInteger(nextSol?.lamports ?? 0) || (nextSol?.lamports ?? 0) < (oldSol?.lamports ?? 0)
    || [oldSol, nextSol].some(a => a && (!a.owner.equals(PublicKey.default) || a.data.length !== 0))) throw invalid();
  for (const index of [1, 2]) {
    const old = before[index], next = after[index], mint = index === 1 ? q.inputMint : q.outputMint;
    if (!next || !tokenIdentity(next, wallet, mint) || (old && !tokenIdentity(old, wallet, mint))) throw invalid();
    if (old) {
      // Preserve delegate, close authority, state and token-2022 extensions.
      if (!old.owner.equals(next.owner) || !old.data.subarray(72).equals(next.data.subarray(72))) throw invalid();
    } else if (next.data.readUInt32LE(72) !== 0 || next.data[108] !== 1 || next.data.readUInt32LE(109) !== 0
      || next.data.readBigUInt64LE(121) !== 0n || next.data.readUInt32LE(129) !== 0) throw invalid();
  }
  const amount = (a: AccountInfo<Buffer> | null | undefined) => a ? a.data.readBigUInt64LE(64) : 0n;
  const debit = amount(before[1]) - amount(after[1]);
  // BUY input is a maximum budget: do not collect unused swap input as a fee.
  // The encoded route still binds the full post-fee budget; SELL is unchanged.
  const inputMatches = q.side === 'BUY'
    ? BigInt(q.economicTradingAmount) + BigInt(q.tradeeFee) === BigInt(q.grossInputAmount)
      && isBuyDebitWithinBudget(debit, BigInt(q.grossInputAmount), BigInt(q.tradeeFee))
    : debit === BigInt(q.grossInputAmount);
  if (!inputMatches
    || amount(after[2]) - amount(before[2]) < BigInt(q.minimumOutputAmount)) throw invalid();
  for (let i = 3; i < before.length; i++) {
    const old = before[i], next = after[i];
    if ((old && tokenIdentity(old, wallet)) || (next && tokenIdentity(next, wallet))) {
      if (!old || !next || !old.owner.equals(next.owner) || !old.data.equals(next.data)) throw invalid();
    }
  }
}
function tokenIdentity(a: AccountInfo<Buffer>, owner: string, mint?: string): boolean {
  return [TOKEN, TOKEN22].includes(a.owner.toBase58()) && a.data.length >= 165
    && new PublicKey(a.data.subarray(32, 64)).toBase58() === owner
    && (mint === undefined || new PublicKey(a.data.subarray(0, 32)).toBase58() === mint);
}
function ata(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA)[0];
}
function invalid() { return new TradingEngineError('TRADE_TRANSACTION_MISMATCH', 'The transaction does not match the reviewed trade.'); }
