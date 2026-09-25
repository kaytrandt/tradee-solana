import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection } from '@solana/web3.js';
import { SolanaTradeEconomicsVerifier, verifyTradeBalanceChanges } from '../src/modules/trading/infrastructure/solana/trade-economics-verifier.js';
import { SolanaFeeTransactionComposer } from '../src/modules/trading/infrastructure/solana/fee-transaction-composer.js';
import type { TradeAggregate } from '../src/modules/trading/domain/trading.js';
import { validateDflowSwapConstraints } from '../src/modules/trading/infrastructure/dflow/dflow-swap-constraints.js';
import { baseUnitAmount } from '../src/modules/trading/domain/base-units.js';

const user = Keypair.generate().publicKey, payer = Keypair.generate().publicKey, feeAccount = Keypair.generate().publicKey;
const usdc = Keypair.generate().publicKey, stock = Keypair.generate().publicKey;
const token = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associated = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const router = new PublicKey('DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH');
const ata = (mint: PublicKey) => PublicKey.findProgramAddressSync([user.toBuffer(), token.toBuffer(), mint.toBuffer()], associated)[0];
function aggregate(sell = false): TradeAggregate {
  return { order: { walletAddress: user.toBase58() }, quote: { inputMint: (sell ? stock : usdc).toBase58(),
    outputMint: (sell ? usdc : stock).toBase58(), grossInputAmount: '100', minimumOutputAmount: '9',
    economicTradingAmount: sell ? '100' : '99', side: sell ? 'SELL' : 'BUY', expectedOutputAmount: '10', slippageBps: 50,
    tradeeFee: '1', tradeeFeeAsset: usdc.toBase58() } } as unknown as TradeAggregate;
}
function account(mint: PublicKey, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(165); mint.toBuffer().copy(data); user.toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = 1;
  return { data, owner: token, executable: false, lamports: 2039280, rentEpoch: 0 };
}
const sol = (): AccountInfo<Buffer> => ({ owner: PublicKey.default, data: Buffer.alloc(0), executable: false, lamports: 10, rentEpoch: 0 });
function fee(amount = 1n, destination = feeAccount) {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = 6;
  return new TransactionInstruction({ programId: token, data, keys: [ata(usdc), usdc, destination, user].map((pubkey, i) => ({ pubkey, isSigner: i === 3, isWritable: i === 0 || i === 2 })) });
}
function payload(input = 99n, output = 10n) {
  const data = Buffer.alloc(35); Buffer.from([248,198,158,145,225,117,135,200]).copy(data);
  data.writeUInt32LE(1, 8); data[12] = 24; data.writeBigUInt64LE(input, 13); data[22] = 1;
  data.writeBigUInt64LE(output, 23); data.writeUInt16LE(50, 31); return data;
}
function swap() { return new TransactionInstruction({ programId: router, data: payload(),
  keys: [token, associated, PublicKey.default, user, ata(usdc), ata(stock)].map(pubkey => ({ pubkey, isSigner: pubkey.equals(user), isWritable: !pubkey.equals(token) })) }); }
function transaction(instructions: TransactionInstruction[]) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions }).compileToV0Message());
}

test('composer rejects the audit PoC: provider already containing a transfer to the allowed treasury', async () => {
  const composer = new SolanaFeeTransactionComposer({ resolve: async () => [] }, usdc.toBase58(), feeAccount.toBase58(), payer.toBase58());
  await assert.rejects(composer.collect(Buffer.from(transaction([swap(), fee(10_000n)]).serialize()).toString('base64'), user.toBase58(), 1n), { code: 'TRADE_TRANSACTION_MISMATCH' });
  const valid = await composer.collect(Buffer.from(transaction([swap()]).serialize()).toString('base64'), user.toBase58(), 1n);
  assert.equal(VersionedTransaction.deserialize(Buffer.from(valid, 'base64')).message.compiledInstructions.length, 2);
});

test('exact fee gate rejects excessive, duplicate, absent, wrong destination and missing swap before RPC', async () => {
  let calls = 0;
  const rpc = { getMultipleAccountsInfo: async () => { calls++; throw Error('unexpected_rpc'); } } as unknown as Connection;
  const validator = new SolanaTradeEconomicsVerifier(rpc, feeAccount.toBase58(), payer.toBase58(), usdc.toBase58(), 6);
  for (const instructions of [[swap(), fee(10_001n)], [swap(), fee(), fee()], [swap()], [swap(), fee(1n, Keypair.generate().publicKey)], [fee()]]) {
    await assert.rejects(validator.validate(aggregate(), transaction(instructions), []), { code: 'TRADE_TRANSACTION_MISMATCH' });
  }
  assert.equal(calls, 0);
});

test('reviewed buy and sell deltas accept exact debit / net minimum and reject hidden economic or authority changes', () => {
  for (const sell of [false, true]) {
    const input = sell ? stock : usdc, output = sell ? usdc : stock;
    const before = [sol(), account(input, 1_000n), account(output, 20n), account(Keypair.generate().publicKey, 80n)];
    const after = [sol(), account(input, 900n), account(output, 29n), before[3]!];
    assert.doesNotThrow(() => verifyTradeBalanceChanges(aggregate(sell), before, after));
    assert.doesNotThrow(() => verifyTradeBalanceChanges(aggregate(sell), [null, ...before.slice(1)], [null, ...after.slice(1)]));
    const lessOutput = [...after]; lessOutput[2] = account(output, 28n);
    assert.throws(() => verifyTradeBalanceChanges(aggregate(sell), before, lessOutput));
    const extraDebit = [...after]; extraDebit[1] = account(input, 899n);
    assert.throws(() => verifyTradeBalanceChanges(aggregate(sell), before, extraDebit));
    const approval = [...after]; approval[1] = account(input, 900n); approval[1].data.writeUInt32LE(1, 72);
    assert.throws(() => verifyTradeBalanceChanges(aggregate(sell), before, approval));
    const drain = [...after]; drain[3] = { ...before[3]!, data: Buffer.from(before[3]!.data) }; drain[3].data.writeBigUInt64LE(0n, 64);
    assert.throws(() => verifyTradeBalanceChanges(aggregate(sell), before, drain));
    const solDebit = [...after]; solDebit[0] = { ...sol(), lamports: 9 };
    assert.throws(() => verifyTradeBalanceChanges(aggregate(sell), before, solDebit));
    assert.doesNotThrow(() => verifyTradeBalanceChanges(aggregate(sell), [sol(), before[1]!, null], [sol(), after[1]!, account(output, 9n)]));
  }
});

test('full verifier inspects writable accounts and simulates the identical unsigned message', async () => {
  const tx = transaction([swap(), fee()]); let simulations = 0;
  let before: (AccountInfo<Buffer> | null)[] = [];
  const rpc = { getMultipleAccountsInfo: async () => [{ owner: token }, { owner: token }],
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      before = keys.map((key, index) => index === 0 ? sol() : key.equals(ata(usdc)) ? account(usdc, 100n) : key.equals(ata(stock)) ? null : sol());
      return { context: { slot: 100 }, value: before };
    }, simulateTransaction: async (actual: VersionedTransaction, config: { minContextSlot: number }) => {
      assert.equal(actual, tx); assert.equal(config.minContextSlot, 100); simulations++;
      const after = [...before]; after[1] = account(usdc, 0n); after[2] = account(stock, 9n);
      return { value: { err: null, accounts: after.map(a => a && ({ ...a, owner: a.owner.toBase58(), data: [a.data.toString('base64'), 'base64'] })) } };
    } } as unknown as Connection;
  await new SolanaTradeEconomicsVerifier(rpc, feeAccount.toBase58(), payer.toBase58(), usdc.toBase58(), 6).validate(aggregate(), tx, []);
  assert.equal(simulations, 1);
});

test('BUY leaves unused input in the wallet without relaxing fees, output, or the reviewed budget', async () => {
  const order = aggregate();
  const quote = { ...order.quote!, grossInputAmount: baseUnitAmount('2000000'), economicTradingAmount: baseUnitAmount('1825000'),
    tradeeFee: baseUnitAmount('175000'), expectedOutputAmount: baseUnitAmount('3387'), minimumOutputAmount: baseUnitAmount('3371') };
  const buy = { ...order, quote };
  const before = [sol(), account(usdc, 16688969n), account(stock, 0n)];
  const after = [sol(), account(usdc, 14689497n), account(stock, 3394n)];
  assert.doesNotThrow(() => verifyTradeBalanceChanges(buy, before, after));
  assert.equal(before[1]!.data.readBigUInt64LE(64) - after[1]!.data.readBigUInt64LE(64), 1999472n);
  for (const debit of [2000000n, 1999999n, 1824999n, 175001n]) {
    assert.doesNotThrow(() => verifyTradeBalanceChanges(buy, before, [sol(), account(usdc, 16688969n - debit), after[2]!]));
  }
  for (const debit of [2000001n, 175000n, 174999n, 0n, -1n]) {
    assert.throws(() => verifyTradeBalanceChanges(buy, before, [sol(), account(usdc, 16688969n - debit), after[2]!]));
  }
  assert.throws(() => verifyTradeBalanceChanges(buy, before, [after[0]!, after[1]!, account(stock, 3370n)]));
  assert.throws(() => verifyTradeBalanceChanges({ ...buy, quote: { ...quote, economicTradingAmount: baseUnitAmount('1824999') } }, before, after));

  const route = swap(); route.data = payload(1825000n, 3387n);
  const tx = transaction([route, fee(175000n)]);
  const rpc = {
    getMultipleAccountsInfo: async () => [{ owner: token }, { owner: token }],
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 100 },
      value: keys.map((_, index) => before[index] ?? null) }),
    simulateTransaction: async (actual: VersionedTransaction, config: { accounts: { addresses: string[] } }) => {
      assert.equal(actual, tx);
      return { value: { err: null, accounts: config.accounts.addresses.map((_, index) => {
        const a = after[index];
        return a ? { ...a, owner: a.owner.toBase58(), data: [a.data.toString('base64'), 'base64'] } : null;
      }) } };
    },
  } as unknown as Connection;
  const verifier = new SolanaTradeEconomicsVerifier(rpc, feeAccount.toBase58(), payer.toBase58(), usdc.toBase58(), 6);
  await verifier.validate(buy, tx, []);
  // Neither the unused amount nor any extra base unit may be added to fees.
  for (const charged of [174999n, 175001n, 175528n]) {
    await assert.rejects(verifier.validate(buy, transaction([route, fee(charged)]), []), { code: 'TRADE_TRANSACTION_MISMATCH' });
  }
  const reducedRoute = swap(); reducedRoute.data = payload(1824472n, 3387n);
  await assert.rejects(verifier.validate(buy, transaction([reducedRoute, fee(175000n)]), []), { code: 'TRADE_TRANSACTION_MISMATCH' });
});

test('SELL pre-sign exact-input validation is unchanged', () => {
  assert.throws(() => verifyTradeBalanceChanges(aggregate(true),
    [sol(), account(stock, 1000n), account(usdc, 0n)],
    [sol(), account(stock, 901n), account(usdc, 9n)]));
});

test('DFlow constraints bind input/output/slippage and reject trailing bytes, fee actions and unknown layouts', () => {
  const quote = aggregate().quote!;
  assert.doesNotThrow(() => validateDflowSwapConstraints(payload(), quote));
  assert.doesNotThrow(() => validateDflowSwapConstraints(payload(100n, 11n), aggregate(true).quote!));
  for (const data of [payload(10000n), payload(99n, 1n), Buffer.concat([payload(), payload()]), payload().subarray(0, 34)]) {
    assert.throws(() => validateDflowSwapConstraints(data, quote));
  }
  for (const tag of [35,36,43,51,52,57,61,63,64,77,255]) {
    const data = payload(); data[12] = tag; assert.throws(() => validateDflowSwapConstraints(data, quote));
  }
  const extraFee = payload(); extraFee.writeUInt16LE(25, 33); assert.throws(() => validateDflowSwapConstraints(extraFee, quote));
  const slip = payload(); slip.writeUInt16LE(500, 31); assert.throws(() => validateDflowSwapConstraints(slip, quote));
});
