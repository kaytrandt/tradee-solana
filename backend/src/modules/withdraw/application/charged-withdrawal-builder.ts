import {baseUnitsToExact} from '../../accounting/domain/exact-amount.js';
import {transactionFeeQuote} from '../../transaction-policy/domain/transaction-fees.js';
import type {NetworkCostEstimator} from '../../trading/application/charged-trade-quote.js';
import {WithdrawError,type WithdrawalTransactionBuilder,type PreparedWithdrawalTransaction} from '../domain/withdraw.js';
import {networkFeeHints,type NetworkFeeHintStore} from '../../transaction-policy/domain/network-fee-hints.js';
import {reportFeeTiming,type FeeTimingObserver,type FeeQuoteTiming} from '../../transaction-policy/domain/fee-quote-timing.js';
import {NO_FEE_BENEFITS,type FeePromotions} from '../../transaction-policy/domain/fee-promotions.js';
export class ChargedWithdrawalBuilder implements WithdrawalTransactionBuilder {
 constructor(private readonly builder:WithdrawalTransactionBuilder,private readonly costs:NetworkCostEstimator,
  private readonly hints:NetworkFeeHintStore=networkFeeHints,private readonly observe?:FeeTimingObserver,
  private readonly promotions?:FeePromotions){}
 async prepare(input:Parameters<WithdrawalTransactionBuilder['prepare']>[0]):Promise<PreparedWithdrawalTransaction>{
  const started=performance.now();
  const timing:FeeQuoteTiming={operation:'WITHDRAW',attempts:0,providerMs:0,composeMs:0,simulationMs:0,totalMs:0,success:false};
  try {const result=await this.prepareMeasured(input,timing);timing.success=true;return result;}
  catch(error){if(input.feeBenefitContext)await this.promotions?.release(input.feeBenefitContext);throw error;}
  finally {timing.totalMs=Math.round(performance.now()-started);reportFeeTiming(this.observe,timing);}
 }
 private async prepareMeasured(input:Parameters<WithdrawalTransactionBuilder['prepare']>[0],timing:FeeQuoteTiming):Promise<PreparedWithdrawalTransaction>{
  // Include the treasury instruction in the first simulation, even for tiny fees.
  const key=JSON.stringify(['WITHDRAW',input.sourceWallet,input.destinationWallet,input.mint,input.feeTokenAccount,input.decimals]);
  let network=await this.hints.get(key,10n**BigInt(input.decimals-2),BigInt(input.amount));
  for(let attempt=0;attempt<3;attempt++){
   timing.attempts++;
   const composeStart=performance.now();
   const prepared=await this.builder.prepare({...input,tradeeWithdrawalFee:baseUnitsToExact(network.toString(),input.decimals)});
   timing.composeMs+=Math.round(performance.now()-composeStart);
   const simulationStart=performance.now();
   const estimate=await this.costs.estimate(prepared.serializedTransaction,prepared.lastValidBlockHeight);
   timing.simulationMs+=Math.round(performance.now()-simulationStart);
   const benefits=input.feeBenefitContext&&this.promotions?await this.promotions.benefits(input.feeBenefitContext,estimate.payerDebitLamports>estimate.networkLamports):NO_FEE_BENEFITS;
   const feeQuote=transactionFeeQuote({...estimate,operation:'WITHDRAW',grossUsdc:BigInt(input.amount),usdcDecimals:input.decimals,benefits});
   this.hints.set(key,BigInt(feeQuote.networkFeeBaseUnits));
   if(BigInt(feeQuote.networkFeeBaseUnits)===network)return {...prepared,feeQuote};
   network=BigInt(feeQuote.networkFeeBaseUnits);
  }
  throw new WithdrawError('WITHDRAW_SPONSORSHIP_FAILED','Network costs changed. Please review a fresh withdrawal.',503,true);
 }
}
