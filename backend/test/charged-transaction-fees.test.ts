import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,ComputeBudgetProgram,TransactionInstruction,TransactionMessage,VersionedTransaction,PublicKey,type Connection} from '@solana/web3.js';
import {ChargedTradeQuote,type NetworkCostEstimator} from '../src/modules/trading/application/charged-trade-quote.js';
import {SolanaFeeTransactionComposer} from '../src/modules/trading/infrastructure/solana/fee-transaction-composer.js';
import {ChargedWithdrawalBuilder} from '../src/modules/withdraw/application/charged-withdrawal-builder.js';
import {SolanaWithdrawalTransactionBuilder} from '../src/modules/withdraw/infrastructure/solana/solana-withdrawal-transaction.js';
import {TradingProviderName,type TradingProvider,type ProviderOrderRequest} from '../src/modules/trading/domain/trading.js';
import {baseUnitAmount as units} from '../src/modules/trading/domain/base-units.js';
import {decimalString} from '../src/modules/assets/domain/asset.js';
import {confirmedReceiptSnapshot} from '../src/modules/trading/application/confirmed-trade-receipt-service.js';
import {NetworkFeeHints} from '../src/modules/transaction-policy/domain/network-fee-hints.js';
import type {FeePromotions} from '../src/modules/transaction-policy/domain/fee-promotions.js';

const payer=Keypair.generate(),user=Keypair.generate(),mint=Keypair.generate().publicKey,treasury=Keypair.generate().publicKey;
const token=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const now=new Date('2026-09-17T12:00:00Z');
const price={source:'JUPITER_PRICE_V3' as const,mint:'So11111111111111111111111111111111111111112',usdPerSol:'100',blockId:'1',blockTime:now.toISOString(),fetchedAt:now.toISOString()};
const cost:NetworkCostEstimator={estimate:async()=>({networkLamports:10_000n,payerDebitLamports:10_000n,price,now})};
function serialized(){return Buffer.from(new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[
 ComputeBudgetProgram.setComputeUnitLimit({units:200_000}),
 new TransactionInstruction({programId:Keypair.generate().publicKey,keys:[{pubkey:user.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([1])})
]}).compileToV0Message()).serialize()).toString('base64');}
function composer(){return new SolanaFeeTransactionComposer({resolve:async()=>[]},mint.toBase58(),treasury.toBase58(),payer.publicKey.toBase58());}
const request:ProviderOrderRequest={inputMint:mint.toBase58(),outputMint:Keypair.generate().publicKey.toBase58(),amount:units('1000000'),userPublicKey:user.publicKey.toBase58(),slippageBps:50,platformFeeBps:0,platformFeeMode:'inputMint',feeAccount:treasury.toBase58()};
function provider(calls:ProviderOrderRequest[]):TradingProvider{return {name:TradingProviderName.DFLOW,async createOrder(r){calls.push(r);return {provider:TradingProviderName.DFLOW,inputMint:r.inputMint,outputMint:r.outputMint,inputAmount:r.amount,outputAmount:units('1000000'),minimumOutputAmount:units('990000'),platformFeeAmount:units('0'),platformFeeBps:0,platformFeeMode:r.platformFeeMode,slippageBps:50,priceImpact:decimalString('0'),lastValidBlockHeight:1000n,providerReference:null,executionMode:'sync',route:[],transaction:serialized()};}};}
function transfers(tx:string){return TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(tx,'base64')).message).instructions.filter(ix=>ix.programId.equals(token)&&ix.data[0]===12);}
test('promotion is embedded in the reviewed buy/sell transfer and preserved on refresh without provider calls',async()=>{
 const promo:FeePromotions={serviceDiscountPercent:async()=>20,benefits:async(_c,hasRent)=>({serviceDiscountPercent:20,rentWaived:hasRent}),release:async()=>{}};
 const rentCost:NetworkCostEstimator={estimate:async()=>({...await cost.estimate('',0n),payerDebitLamports:2049280n})};
 for(const side of ['BUY','SELL'] as const){
  const calls:ProviderOrderRequest[]=[];
  const quotes=new ChargedTradeQuote(provider(calls),composer(),rentCost,6,new NetworkFeeHints(),undefined,promo);
  const result=await quotes.prepare(request,side,{userId:'user',referenceId:'ref'});
  assert.equal(result.feeQuote.serviceFeeBaseUnits,'2000');
  assert.equal(result.feeQuote.rentChargeBaseUnits,'0');
  assert.equal(transfers(result.transaction)[0]!.data.readBigUInt64LE(1),12000n);
  assert.equal(calls[0]!.amount,side==='BUY'?'988000':'1000000');
  if(side==='SELL')assert.equal(result.outputAmount,'988000');
  const count=calls.length;
  assert.deepEqual((await quotes.refresh(result.transaction,1000n,side,1000000n,result.feeQuote))?.benefits,result.feeQuote.benefits);
  assert.equal(calls.length,count);
 }
});
test('withdraw promotion waives only rent; unsuccessful preparation releases its reservation',async()=>{
 let releases=0;
 const promo:FeePromotions={serviceDiscountPercent:async()=>20,benefits:async(_c,hasRent)=>({serviceDiscountPercent:20,rentWaived:hasRent}),release:async()=>{releases++;}};
 const builder=new SolanaWithdrawalTransactionBuilder('https://example.invalid',async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}),payer.publicKey.toBase58());
 const data=Buffer.alloc(165);mint.toBuffer().copy(data);treasury.toBuffer().copy(data,32);data[108]=1;
 (builder as unknown as {connection:Connection}).connection.getAccountInfo=async()=>({data,owner:token,lamports:1,executable:false,rentEpoch:0});
 const rentCost:NetworkCostEstimator={estimate:async()=>({...await cost.estimate('',0n),payerDebitLamports:2049280n})};
 const input={sourceWallet:user.publicKey.toBase58(),destinationWallet:Keypair.generate().publicKey.toBase58(),mint:mint.toBase58(),amount:units('1000000'),decimals:6,feeTokenAccount:treasury.toBase58(),feeBenefitContext:{userId:'u',referenceId:'withdraw'}};
 const prepared=await new ChargedWithdrawalBuilder(builder,rentCost,new NetworkFeeHints(),undefined,promo).prepare(input);
 assert.equal(prepared.feeQuote!.rentChargeBaseUnits,'0');
 assert.equal(prepared.feeQuote!.serviceFeeBaseUnits,'0');
 assert.deepEqual(transfers(prepared.serializedTransaction).map(ix=>ix.data.readBigUInt64LE(1)),[990000n,10000n]);
 await assert.rejects(new ChargedWithdrawalBuilder(builder,{estimate:async()=>{throw Error('failed');}},new NetworkFeeHints(),undefined,promo).prepare(input));
 assert.equal(releases,1);
});
test('composed unsigned message preserves route and adds exact USDC treasury transfer',async()=>{
 const original=serialized(),result=await composer().collect(original,user.publicKey.toBase58(),12500n);
 const before=VersionedTransaction.deserialize(Buffer.from(original,'base64')),after=VersionedTransaction.deserialize(Buffer.from(result,'base64'));
 assert.equal(after.message.recentBlockhash,before.message.recentBlockhash);
 assert.equal(after.message.header.numRequiredSignatures,2);
 assert.ok(after.signatures.every(s=>s.every(b=>b===0)));
 const [fee]=transfers(result);assert.equal(transfers(result).length,1);
 assert.equal(fee!.data.readBigUInt64LE(1),12500n);assert.equal(fee!.data[9],6);
 assert.ok(fee!.keys[1]!.pubkey.equals(mint));assert.ok(fee!.keys[2]!.pubkey.equals(treasury));assert.ok(fee!.keys[3]!.pubkey.equals(user.publicKey));
 const instructions=TransactionMessage.decompile(after.message).instructions;
 assert.equal(instructions[0]!.data.readUInt32LE(1),220000);
 assert.deepEqual(instructions[1],TransactionMessage.decompile(before.message).instructions[1]);
});
test('composer refuses signed messages, wrong payer/user and invalid fee amounts',async()=>{
 const signed=VersionedTransaction.deserialize(Buffer.from(serialized(),'base64'));signed.sign([user]);
 await assert.rejects(composer().collect(Buffer.from(signed.serialize()).toString('base64'),user.publicKey.toBase58(),1n));
 await assert.rejects(composer().collect(serialized(),payer.publicKey.toBase58(),1n));
 const wrong=new SolanaFeeTransactionComposer({resolve:async()=>[]},mint.toBase58(),treasury.toBase58(),Keypair.generate().publicKey.toBase58());
 await assert.rejects(wrong.collect(serialized(),user.publicKey.toBase58(),1n));
 for(const n of [0n,-1n,2n**64n])await assert.rejects(composer().collect(serialized(),user.publicKey.toBase58(),n));
});
test('buy and sell converge using final message: no fee added above buy gross and sell net includes both fees',async()=>{
 for(const side of ['BUY','SELL'] as const){
  const calls:ProviderOrderRequest[]=[];const result=await new ChargedTradeQuote(provider(calls),composer(),cost,6).prepare(request,side);
  assert.equal(calls.length,1);assert.ok(calls.every(c=>c.platformFeeBps===0));
  assert.equal(result.feeQuote.totalFeeBaseUnits,'12500');assert.equal(result.inputAmount,'1000000');
  assert.equal(transfers(result.transaction)[0]!.data.readBigUInt64LE(1),12500n);
  assert.equal(calls[0]!.amount,side==='BUY'?'987500':'1000000');
  if(side==='SELL'){assert.equal(result.outputAmount,'987500');assert.equal(result.minimumOutputAmount,'977500');}
 }
});
test('moving costs, failed simulation and unexpected provider fees never return an executable quote',async()=>{
 let i=0;
 const moving:NetworkCostEstimator={estimate:async()=>({...await cost.estimate('',0n),networkLamports:BigInt(++i)*1_000_000n,payerDebitLamports:BigInt(i)*1_000_000n})};
 await assert.rejects(new ChargedTradeQuote(provider([]),composer(),moving,6).prepare(request,'BUY'));
 const bad:TradingProvider={name:TradingProviderName.DFLOW,createOrder:async r=>({...await provider([]).createOrder(r),platformFeeBps:25})};
 await assert.rejects(new ChargedTradeQuote(bad,composer(),cost,6).prepare(request,'BUY'));
 await assert.rejects(new ChargedTradeQuote(provider([]),composer(),{estimate:async()=>{throw Error('simulation failed');}},6).prepare(request,'BUY'));
});
test('withdraw builder collects one-cent network minimum atomically and deducts it from recipient amount',async()=>{
 const builder=new SolanaWithdrawalTransactionBuilder('https://example.invalid',async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}),payer.publicKey.toBase58());
 const data=Buffer.alloc(165);mint.toBuffer().copy(data);treasury.toBuffer().copy(data,32);data[108]=1;
 (builder as unknown as {connection:Connection}).connection.getAccountInfo=async()=>({data,owner:token,lamports:1,executable:false,rentEpoch:0});
 const prepared=await new ChargedWithdrawalBuilder(builder,cost).prepare({sourceWallet:user.publicKey.toBase58(),destinationWallet:Keypair.generate().publicKey.toBase58(),mint:mint.toBase58(),amount:units('1000000'),decimals:6,feeTokenAccount:treasury.toBase58()});
 assert.equal(prepared.feeQuote!.serviceFeeBaseUnits,'0');assert.equal(prepared.feeQuote!.networkFeeBaseUnits,'10000');
 const amounts=transfers(prepared.serializedTransaction).map(ix=>ix.data.readBigUInt64LE(1));
 assert.deepEqual(amounts,[990000n,10000n]);
});
test('sell reconciliation accepts reviewed service plus network, but rejects any changed fee',()=>{
 const r={executionId:'e',userId:'u',signature:'s',walletAddress:'w',side:'SELL' as const,assetMint:'a',assetDecimals:6,multiplier:'1',cashMint:'c',cashDecimals:6,grossInput:'1000000',economicInput:'1000000',minimumOutput:'970000',maximumFee:'12500',feeBps:25,exactFee:true};
 const m={assetDelta:-1000000n,cashDelta:987500n,feeRaw:12500n,slot:1,executedAt:now};
 assert.equal(confirmedReceiptSnapshot(r,m).fee,'0.0125');
 assert.throws(()=>confirmedReceiptSnapshot(r,{...m,feeRaw:12501n}));
 assert.throws(()=>confirmedReceiptSnapshot(r,{...m,feeRaw:12499n}));
 assert.throws(()=>confirmedReceiptSnapshot({...r,exactFee:false},m));
});
test('warm route hints survive amount edits and changed rent still requires final-message simulation',async()=>{
 const hints=new NetworkFeeHints();const calls:ProviderOrderRequest[]=[];
 let debit=1_000_000n;let simulations=0;
 const estimator:NetworkCostEstimator={estimate:async()=>{simulations++;return {...await cost.estimate('',0n),payerDebitLamports:debit};}};
 const quotes=new ChargedTradeQuote(provider(calls),composer(),estimator,6,hints);
 const cold=await quotes.prepare(request,'BUY');
 assert.equal(cold.feeQuote.networkFeeBaseUnits,'150000');assert.equal(calls.length,2);assert.equal(simulations,2);
 calls.length=0;simulations=0;
 const editedRequest={...request,amount:units('2000000')};
 const edited=await quotes.prepare(editedRequest,'BUY');
 assert.equal(calls.length,1);assert.equal(simulations,1);
 assert.equal(calls[0]!.amount,'1845000');
 assert.equal(edited.inputAmount,'2000000');
 assert.equal(transfers(edited.transaction)[0]!.data.readBigUInt64LE(1),155000n);
 calls.length=0;simulations=0;debit=2_000_000n;
 const changed=await quotes.prepare(request,'BUY');
 assert.equal(changed.feeQuote.networkFeeBaseUnits,'150000');assert.equal(calls.length,1);assert.equal(simulations,1);
 assert.equal(transfers(changed.transaction)[0]!.data.readBigUInt64LE(1),152500n);
});
test('refresh uses existing message with zero provider calls and refuses changed charges',async()=>{
 const calls:ProviderOrderRequest[]=[];let rent=false;
 const estimator:NetworkCostEstimator={estimate:async()=>({...await cost.estimate('',0n),payerDebitLamports:rent?1559560n:10000n})};
 const quotes=new ChargedTradeQuote(provider(calls),composer(),estimator,6,new NetworkFeeHints());
 const q=await quotes.prepare(request,'BUY');calls.length=0;
 const refreshed=await quotes.refresh(q.transaction,q.lastValidBlockHeight,'BUY',1000000n,q.feeQuote);
 assert.ok(refreshed);assert.equal(calls.length,0);
 rent=true;assert.equal(await quotes.refresh(q.transaction,q.lastValidBlockHeight,'BUY',1000000n,q.feeQuote),null);
 assert.equal(calls.length,0);
});
test('sell converges by recomposing the same unsigned provider route, never stacking fee transfers',async()=>{
 const calls:ProviderOrderRequest[]=[];let simulations=0;
 const estimator:NetworkCostEstimator={estimate:async tx=>{simulations++;assert.equal(transfers(tx).length,1);return {...await cost.estimate('',0n),payerDebitLamports:1_000_000n};}};
 const result=await new ChargedTradeQuote(provider(calls),composer(),estimator,6,new NetworkFeeHints()).prepare(request,'SELL');
 assert.equal(calls.length,1);assert.equal(simulations,2);assert.equal(result.feeQuote.networkFeeBaseUnits,'150000');
 assert.equal(transfers(result.transaction)[0]!.data.readBigUInt64LE(1),152500n);
});
test('fee hints expire, are bounded, and never use an unaffordable hint',async()=>{
 let time=0;const hints=new NetworkFeeHints(()=>time,30,2);
 hints.set('a',20n);assert.equal(await hints.get('a',10n,100n),20n);
 assert.equal(await hints.get('a',10n,15n),10n);
 hints.set('a',20n);time=31;assert.equal(await hints.get('a',10n,100n),10n);
 hints.set('a',20n);hints.set('b',20n);hints.set('c',20n);
 assert.equal(await hints.get('a',10n,100n),10n);
});
test('fee hints warm another backend instance through a hashed fail-open shared cache key',async()=>{
 const values=new Map<string,string>();let writtenKey='';
 const shared={
  get:async(key:string)=>values.get(key)??null,
  set:async(key:string,value:string)=>{writtenKey=key;values.set(key,value);},
 };
 const privateKey=JSON.stringify(['BUY','wallet-address','usdc','stock',6]);
 const first=new NetworkFeeHints(Date.now,90_000,2_000,shared,'trade');
 first.set(privateKey,150000n);
 assert.ok(writtenKey.startsWith('tradee:network-fee-hint:trade:'));
 assert.ok(!writtenKey.includes('wallet-address'));
 const second=new NetworkFeeHints(Date.now,90_000,2_000,shared,'trade');
 assert.equal(await second.get(privateKey,10000n,2_000_000n),150000n);
 const unavailable=new NetworkFeeHints(Date.now,90_000,2_000,{get:async()=>{throw new Error('offline');},set:async()=>{}},'trade');
 assert.equal(await unavailable.get(privateKey,10000n,2_000_000n),10000n);
});
