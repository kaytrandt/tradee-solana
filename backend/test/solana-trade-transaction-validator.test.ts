import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { decimalString } from "../src/modules/assets/domain/asset.js";
import {
  digestTransaction, SolanaTradeTransactionValidator,
} from "../src/modules/trading/application/solana-trade-transaction-validator.js";
import { baseUnitAmount } from "../src/modules/trading/domain/base-units.js";
import {
  TradeOrderState, TradingEngineError, TradingProviderName, type TradeAggregate,
} from "../src/modules/trading/domain/trading.js";
import { TradingSide } from "../src/modules/transaction-policy/domain/trading-policy.js";

const user = Keypair.generate().publicKey;
const inputMint = Keypair.generate().publicKey;
const outputMint = Keypair.generate().publicKey;
const feeAccount = Keypair.generate().publicKey;

test('fee-free migration validation does not weaken paid-trade fee or program checks',async()=>{
  const serialized=transaction(new TransactionInstruction({programId:SystemProgram.programId,keys:keys().filter(k=>!k.pubkey.equals(feeAccount)),data:Buffer.from([0])}));
  const original=fixture(serialized);
  const free={...original,quote:{...original.quote!,tradeeFee:baseUnitAmount('0'),tradeeFeeBps:0,economicTradingAmount:baseUnitAmount('100')}};
  await configuredValidator().validateFeeFreeSwap(free);
  await assert.rejects(configuredValidator().validate(free),engineError('TRADE_DESTINATION_NOT_ALLOWED'));
  await assert.rejects(configuredValidator().validateFeeFreeSwap(original),engineError('TRADE_FEE_MISMATCH'));
  const unknown=transaction(new TransactionInstruction({programId:Keypair.generate().publicKey,keys:keys(),data:Buffer.from([0])}));
  await assert.rejects(configuredValidator().validateFeeFreeSwap({...free,quote:{...free.quote,transaction:unknown,transactionDigest:digestTransaction(unknown)}}),engineError('TRADE_PROGRAM_NOT_ALLOWED'));
});

test("validator binds exact transaction, wallet, mints, fee destination and programs", async () => {
  const aggregate = fixture(safeTransaction());
  const validator = configuredValidator();
  const result = await validator.validate(aggregate);
  assert.equal(result.transactionDigest, aggregate.quote?.transactionDigest);

  const changed = fixture(safeTransaction(), { digest: aggregate.quote!.transactionDigest });
  await assert.rejects(validator.validate(changed), engineError("TRADE_TRANSACTION_MISMATCH"));

  await assert.rejects(
    validator.validate(fixture(safeTransaction(), { walletAddress: Keypair.generate().publicKey.toBase58() })),
    engineError("TRADE_WALLET_MISMATCH"),
  );
});

test("validator rejects unknown programs and direct transfers to unapproved destinations", async () => {
  const unknownProgram = Keypair.generate().publicKey;
  const unknown = transaction(new TransactionInstruction({
    programId: unknownProgram,
    keys: keys(),
    data: Buffer.from([0]),
  }));
  await assert.rejects(configuredValidator().validate(fixture(unknown)), engineError("TRADE_PROGRAM_NOT_ALLOWED"));

  const destination = Keypair.generate().publicKey;
  const unsafeTransfer = transaction([
    SystemProgram.transfer({ fromPubkey: user, toPubkey: destination, lamports: 1 }),
    new TransactionInstruction({ programId: SystemProgram.programId, keys: keys(), data: Buffer.from([0]) }),
  ]);
  const transferAggregate = fixture(unsafeTransfer);
  await assert.rejects(configuredValidator().validate(transferAggregate), engineError("TRADE_DESTINATION_NOT_ALLOWED"));
});

test("validator accepts a sponsored route that references the user's ATA instead of the mint", async () => {
  const sponsored = transaction(new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAccount(user, inputMint), isSigner: false, isWritable: true },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: feeAccount, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([0]),
  }));

  await assert.doesNotReject(configuredValidator().validate(fixture(sponsored)));

  const unrelatedAccount = transaction(new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: feeAccount, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([0]),
  }));
  await assert.rejects(
    configuredValidator().validate(fixture(unrelatedAccount)),
    engineError("TRADE_MINT_MISMATCH"),
  );
});

test("direct SPL transfers are checked by the user's token account/authority, not only owner address", async () => {
  const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const validator = new SolanaTradeTransactionValidator({ resolve: async () => [] }, {
    allowedProgramIds: new Set([tokenProgram.toBase58(), SystemProgram.programId.toBase58()]),
    allowedDestinationAccounts: new Set(), feeAccountUsdc: feeAccount.toBase58(),
  });
  const transfer = Buffer.alloc(9); transfer[0] = 3; transfer.writeBigUInt64LE(100n, 1);
  const drain = transaction([
    new TransactionInstruction({ programId: tokenProgram, keys: [
      { pubkey: associatedTokenAccount(user, inputMint), isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: false },
    ], data: transfer }),
    new TransactionInstruction({ programId: SystemProgram.programId, keys: keys(), data: Buffer.from([0]) }),
  ]);
  await assert.rejects(validator.validate(fixture(drain)), engineError("TRADE_DESTINATION_NOT_ALLOWED"));
  const approval = transaction(new TransactionInstruction({ programId: tokenProgram, keys: keys(), data: Buffer.from([4]) }));
  await assert.rejects(validator.validate(fixture(approval)), engineError("TRADE_PROGRAM_NOT_ALLOWED"));
});

test("explicit SPL allowlist permits checked fee transfer but still rejects a different destination", async () => {
  const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const validator = new SolanaTradeTransactionValidator({ resolve: async () => [] }, {
    allowedProgramIds: new Set([SystemProgram.programId.toBase58(), tokenProgram.toBase58()]),
    allowedDestinationAccounts: new Set(), feeAccountUsdc: feeAccount.toBase58(),
  });
  const make = (destination: PublicKey) => {
    const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(1n, 1); data[9] = 6;
    return fixture(transaction([
      new TransactionInstruction({ programId: SystemProgram.programId, keys: keys(), data: Buffer.from([0]) }),
      new TransactionInstruction({ programId: tokenProgram, keys: [
        { pubkey: associatedTokenAccount(user, inputMint), isSigner: false, isWritable: true },
        { pubkey: inputMint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: true, isWritable: false },
      ], data }),
    ]));
  };
  await assert.rejects(configuredValidator().validate(make(feeAccount)), engineError("TRADE_PROGRAM_NOT_ALLOWED"));
  await assert.doesNotReject(validator.validate(make(feeAccount)));
  await assert.rejects(validator.validate(make(Keypair.generate().publicKey)), engineError("TRADE_DESTINATION_NOT_ALLOWED"));
});

function configuredValidator() {
  return new SolanaTradeTransactionValidator({ resolve: async () => [] }, {
    allowedProgramIds: new Set([SystemProgram.programId.toBase58()]),
    allowedDestinationAccounts: new Set(),
    feeAccountUsdc: feeAccount.toBase58(),
  });
}

function safeTransaction(payer = user.toBase58()): string {
  return transaction([new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: keys(),
    data: Buffer.from([0]),
  })], payer);
}

function transaction(instructions: TransactionInstruction | readonly TransactionInstruction[], payer = user.toBase58()): string {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: Array.isArray(instructions) ? [...instructions] : [instructions],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function keys() {
  return [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: inputMint, isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    { pubkey: feeAccount, isSigner: false, isWritable: true },
  ];
}

function associatedTokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const associatedTokenProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    associatedTokenProgram,
  )[0];
}

function fixture(serialized: string, options: { digest?: string; walletAddress?: string } = {}): TradeAggregate {
  const digest = options.digest ?? digestTransaction(serialized);
  const now = new Date("2026-09-01T00:00:00Z");
  return {
    order: {
      orderId: "11111111-1111-4111-8111-111111111111", userId: "user", walletId: "wallet",
      walletAddress: options.walletAddress ?? user.toBase58(), assetId: "22222222-2222-4222-8222-222222222222",
      side: TradingSide.BUY, requestedAmount: "100", quoteId: "quote",
      state: TradeOrderState.AWAITING_SIGNATURE, provider: TradingProviderName.DFLOW,
      idempotencyKey: "key", submissionClaimedAt: null, submissionPayloadHash: null,
      riskAcknowledgedAt: null, failureCode: null,
      createdAt: now, updatedAt: now,
    },
    quote: {
      quoteId: "quote", orderId: "11111111-1111-4111-8111-111111111111",
      assetId: "22222222-2222-4222-8222-222222222222", side: TradingSide.BUY,
      inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
      grossInputAmount: baseUnitAmount("100"), economicTradingAmount: baseUnitAmount("99"),
      expectedOutputAmount: baseUnitAmount("10"), minimumOutputAmount: baseUnitAmount("9"),
      tradeeFee: baseUnitAmount("1"), tradeeFeeBps: 100, tradeeFeeAsset: inputMint.toBase58(),
      slippageBps: 50, priceImpact: decimalString("0.01"), quotedAt: now,
      executionRisk: { requiresAcknowledgement: false, reason: null, thresholdPercent: decimalString("1") },
      lastValidBlockHeight: 100n, providerReference: null, executionMode: "sync", route: [],
      transaction: serialized,
      transactionDigest: digest, requiredSigners: [user.toBase58()],
    },
    execution: null,
  };
}

function engineError(code: TradingEngineError["code"]) {
  return (error: unknown) => error instanceof TradingEngineError && error.code === code;
}
