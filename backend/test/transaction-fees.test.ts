import test from 'node:test';
import assert from 'node:assert/strict';
import { networkChargeUnits,serviceFeeUnits,transactionFeeQuote } from '../src/modules/transaction-policy/domain/transaction-fees.js';
const now=new Date('2026-09-17T11:12:59Z');
const price={source:'JUPITER_PRICE_V3' as const,mint:'So11111111111111111111111111111111111111112',usdPerSol:'99.96914133661956',blockId:'447780955',blockTime:now.toISOString(),fetchedAt:now.toISOString()};
test('referral discount is 20% of service fee; waived rent does not waive or multiply chain cost',()=>{
 for(const operation of ['BUY','SELL','WITHDRAW'] as const){
  const q=transactionFeeQuote({operation,grossUsdc:100_000_000n,networkLamports:110000n,payerDebitLamports:2149280n,price,now,
   benefits:{serviceDiscountPercent:20,rentWaived:true}});
  assert.equal(q.serviceFeeBaseUnits,operation==='WITHDRAW'?'0':'200000');
  assert.equal(q.networkFeeBaseUnits,'20000');assert.equal(q.rentChargeBaseUnits,'0');
  assert.equal(q.estimatedPayerDebitLamports,'2149280');
 }
 const benefits={serviceDiscountPercent:20,rentWaived:true};
 assert.equal(serviceFeeUnits(99999999n,'BUY',benefits),199999n);
 assert.equal(serviceFeeUnits(1000000n,'SELL',{...benefits,serviceDiscountPercent:100}),0n);
 for(const discount of [-1,101,0.5,NaN])assert.throws(()=>serviceFeeUnits(1000000n,'BUY',{...benefits,serviceDiscountPercent:discount}));
});
test('service fee is exactly 25 bps with base-unit floor and no amount tiers',()=>{
  for(const gross of [1_000_000n,2_000_000n,50_000_000n,200_000_000n,999_999_999_999_999n]){
    assert.equal(serviceFeeUnits(gross,'BUY'),gross*25n/10000n);
    assert.equal(serviceFeeUnits(gross,'SELL'),gross*25n/10000n);
    assert.equal(serviceFeeUnits(gross,'WITHDRAW'),0n);
  }
});
test('network fee gets 1.5x but fixed rent is added once without multiplier',()=>{
 const q=transactionFeeQuote({operation:'BUY',grossUsdc:2_000_000n,networkLamports:110000n,payerDebitLamports:1669560n,price,now});
 assert.equal(q.estimatedRentLamports,'1559560');assert.equal(q.networkFeeBaseUnits,'170000');
 assert.equal(q.rentChargeBaseUnits,'150000');
 assert.equal(q.serviceFeeBaseUnits,'5000');assert.equal(q.totalFeeBaseUnits,'175000');
 assert.equal(q.refreshAfterMs,5000);assert.equal(2_000_000n-BigInt(q.totalFeeBaseUnits),1825000n);
});
test('fixed rent is independent of rent amount and rounding minimum applies to final total',()=>{
 for(const operation of ['BUY','SELL','WITHDRAW'] as const)for(const rent of [1n,1559560n,9000000n]){
  const q=transactionFeeQuote({operation,grossUsdc:1000000n,networkLamports:1n,payerDebitLamports:rent+1n,price,now});
  assert.equal(q.networkFeeBaseUnits,'150000');assert.equal(q.rentChargeBaseUnits,'150000');
 }
 assert.equal(networkChargeUnits(100000n,'100',6,true),170000n);
});
test('withdraw charges only network reimbursement',()=>{
 const q=transactionFeeQuote({operation:'WITHDRAW',grossUsdc:1_000_000n,networkLamports:10000n,payerDebitLamports:10000n,price,now});
 assert.equal(q.serviceFeeBaseUnits,'0');assert.equal(q.networkFeeBaseUnits,'10000');
});
test('refunds cannot cancel network fee or produce a negative rent charge',()=>{
 const q=transactionFeeQuote({operation:'SELL',grossUsdc:2_000_000n,networkLamports:110000n,payerDebitLamports:0n,price,now});
 assert.equal(q.estimatedRentLamports,'0');assert.equal(q.networkFeeBaseUnits,'20000');
});
test('network fees round half up to cents and never use floating point',()=>{
 assert.equal(networkChargeUnits(1n,'0.01'),10000n);
 assert.equal(networkChargeUnits(1_000_000n,'10'),20000n); // exactly $0.015 -> $0.02
 assert.equal(networkChargeUnits(1_000_000n,'3.333'),10000n); // below half a cent: minimum applies
 assert.equal(networkChargeUnits(1_000_000n,'3.334'),10000n);
 assert.equal(networkChargeUnits(110_000n,'100'),20000n); // $0.0165 -> $0.02
 assert.equal(networkChargeUnits(1_000_000n,'166.93333333333333333333'),250000n);
 assert.equal(networkChargeUnits(1_000_000n,'170'),260000n); // $0.255 -> $0.26
 assert.equal(networkChargeUnits(1_000_000n,'10',2),2n);
 assert.equal(networkChargeUnits(0n,'100'),10000n);
 assert.equal(networkChargeUnits(1_000_000_000n,'100'),150_000_000n);
 assert.throws(()=>networkChargeUnits(-1n,'100'));
 assert.throws(()=>networkChargeUnits(100n,'0'));
 assert.throws(()=>transactionFeeQuote({operation:'BUY',grossUsdc:1n,networkLamports:110000n,payerDebitLamports:110000n,price,now}));
});
test('all operations apply the one-cent minimum without changing raw costs',()=>{
 for(const operation of ['BUY','SELL','WITHDRAW'] as const){
  const q=transactionFeeQuote({operation,grossUsdc:1_000_000n,networkLamports:1n,payerDebitLamports:1n,price,now});
  assert.equal(q.networkFeeBaseUnits,'10000');
  assert.equal(q.estimatedNetworkLamports,'1');
  assert.equal(q.estimatedPayerDebitLamports,'1');
  assert.equal(q.estimatedRentLamports,'0');
  assert.equal(q.totalFeeBaseUnits,operation==='WITHDRAW'?'10000':'12500');
 }
 assert.equal(networkChargeUnits(1n,'100',2),1n);
 assert.equal(networkChargeUnits(1n,'100',18),10n**16n);
 assert.throws(()=>transactionFeeQuote({operation:'WITHDRAW',grossUsdc:10000n,networkLamports:1n,payerDebitLamports:1n,price,now}));
});
