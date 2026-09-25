import { baseUnitAmount } from '../domain/base-units.js';
import { TradingEngineError, type ProviderOrderRequest, type ProviderPreparedOrder, type TradingProvider } from '../domain/trading.js';
import { serviceFeeUnits, transactionFeeQuote, type TransactionFeeQuote } from '../../transaction-policy/domain/transaction-fees.js';
import type { NativeFeePrice } from '../../wallet/fee-payer/fee-usd-valuation.js';
import { networkFeeHints, type NetworkFeeHintStore } from '../../transaction-policy/domain/network-fee-hints.js';
import {reportFeeTiming,type FeeTimingObserver,type FeeQuoteTiming} from '../../transaction-policy/domain/fee-quote-timing.js';
import {NO_FEE_BENEFITS,type FeeBenefitContext,type FeePromotions} from '../../transaction-policy/domain/fee-promotions.js';

export interface NetworkCostEstimator {
  estimate(transaction:string,lastValidBlockHeight:bigint):Promise<{networkLamports:bigint;payerDebitLamports:bigint;price:NativeFeePrice;now:Date}>;
}
export interface FeeTransactionComposer {
  /** Adds an exact USDC transfer before signing. Never accepts signed transactions. */
  collect(transaction:string,wallet:string,feeUnits:bigint):Promise<string>;
}
/** Charges are prepared atomically with the route, not a second user transaction. */
export class ChargedTradeQuote {
  constructor(private readonly provider:TradingProvider,private readonly composer:FeeTransactionComposer,
    private readonly estimator:NetworkCostEstimator,private readonly usdcDecimals:number,
    private readonly hints:NetworkFeeHintStore=networkFeeHints,private readonly observe?:FeeTimingObserver,
    private readonly promotions?:FeePromotions){}
  /** Revalidate the existing final message. No provider order or composition. */
  async refresh(transaction:string,lastValidBlockHeight:bigint,side:'BUY'|'SELL',gross:bigint,previous:TransactionFeeQuote):Promise<TransactionFeeQuote|null>{
    const estimate=await this.estimator.estimate(transaction,lastValidBlockHeight);
    const fresh=transactionFeeQuote({...estimate,operation:side,grossUsdc:gross,usdcDecimals:this.usdcDecimals,benefits:previous.benefits??NO_FEE_BENEFITS});
    return fresh.totalFeeBaseUnits===previous.totalFeeBaseUnits&&fresh.serviceFeeBaseUnits===previous.serviceFeeBaseUnits
      &&fresh.networkFeeBaseUnits===previous.networkFeeBaseUnits?fresh:null;
  }
  async prepare(request:ProviderOrderRequest,side:'BUY'|'SELL',context?:FeeBenefitContext):Promise<ProviderPreparedOrder & {feeQuote:TransactionFeeQuote}>{
    const started=performance.now();
    const timing:FeeQuoteTiming={operation:side,attempts:0,providerMs:0,composeMs:0,simulationMs:0,totalMs:0,success:false};
    try {const result=await this.prepareMeasured(request,side,timing,context);timing.success=true;return result;}
    catch(error){if(context)await this.promotions?.release(context);throw error;}
    finally {timing.totalMs=Math.round(performance.now()-started);reportFeeTiming(this.observe,timing);}
  }
  private async prepareMeasured(request:ProviderOrderRequest,side:'BUY'|'SELL',timing:FeeQuoteTiming,context?:FeeBenefitContext):Promise<ProviderPreparedOrder & {feeQuote:TransactionFeeQuote}>{
    let benefits=context&&this.promotions?await this.promotions.benefits(context,false):NO_FEE_BENEFITS;
    const grossInput=BigInt(request.amount);
    // Network cost is driven by the wallet, side and route shape, not the user's
    // exact input amount. Reuse the last simulated cost while the user edits an
    // amount so BUY normally needs one DFlow order instead of a convergence
    // order followed by a replacement. The exact final message is still
    // recomposed and simulated below; a stale hint only causes another loop.
    const key=JSON.stringify([side,request.userPublicKey,request.inputMint,request.outputMint,this.usdcDecimals]);
    const minimum=10n**BigInt(this.usdcDecimals-2);
    let network=await this.hints.get(key,minimum,side==='BUY'?grossInput-serviceFeeUnits(grossInput,side,benefits):grossInput);
    let sellOrder:ProviderPreparedOrder|undefined;
    // A changed route may need different rent. Only return a quote when the full
    // composed transaction's estimate matches its exact charged base units.
    for(let attempt=0;attempt<3;attempt++){
      timing.attempts++;
      const buyService=side==='BUY'?serviceFeeUnits(grossInput,side,benefits):0n;
      const swapInput=side==='BUY'?grossInput-buyService-network:grossInput;
      if(swapInput<=0n)throw unavailable('Amount must exceed service and network fees.');
      const providerStart=performance.now();
      const prepared=sellOrder??await this.provider.createOrder({...request,amount:baseUnitAmount(swapInput.toString()),platformFeeBps:0});
      timing.providerMs+=Math.round(performance.now()-providerStart);
      // SELL input never changes during fee convergence. Recompose the original
      // unsigned route; do not refetch it or append a second fee instruction.
      if(side==='SELL')sellOrder=prepared;
      if(prepared.platformFeeBps!==0||prepared.platformFeeAmount!=='0'||prepared.inputAmount!==swapInput.toString())throw unavailable('Unexpected provider fee or amount.');
      const gross=side==='BUY'?grossInput:BigInt(prepared.outputAmount);
      const service=serviceFeeUnits(gross,side,benefits),total=service+network;
      if(attempt===0&&network>minimum&&(total>=gross||(side==='SELL'&&total>=BigInt(prepared.minimumOutputAmount)))){network=minimum;continue;}
      if(total>=gross || (side==='SELL'&&total>=BigInt(prepared.minimumOutputAmount)))throw unavailable('Minimum output must cover service and network fees.');
      const composeStart=performance.now();
      const transaction=await this.composer.collect(prepared.transaction,request.userPublicKey,total);
      timing.composeMs+=Math.round(performance.now()-composeStart);
      const simulationStart=performance.now();
      const estimate=await this.estimator.estimate(transaction,prepared.lastValidBlockHeight);
      timing.simulationMs+=Math.round(performance.now()-simulationStart);
      if(context&&this.promotions) {
        const next=await this.promotions.benefits(context,estimate.payerDebitLamports>estimate.networkLamports);
        // Freeze the reviewed service rate; do not change it midway through convergence.
        benefits={...benefits,rentWaived:next.rentWaived};
      }
      const fees=transactionFeeQuote({...estimate,operation:side,grossUsdc:gross,usdcDecimals:this.usdcDecimals,benefits});
      this.hints.set(key,BigInt(fees.networkFeeBaseUnits));
      if(BigInt(fees.networkFeeBaseUnits)!==network){network=BigInt(fees.networkFeeBaseUnits);continue;}
      return {...prepared,transaction,feeQuote:fees,inputAmount:request.amount,platformFeeAmount:baseUnitAmount(fees.totalFeeBaseUnits),platformFeeBps:fees.serviceFeeBps,
        outputAmount:side==='BUY'?prepared.outputAmount:baseUnitAmount((BigInt(prepared.outputAmount)-total).toString()),
        minimumOutputAmount:side==='BUY'?prepared.minimumOutputAmount:baseUnitAmount((BigInt(prepared.minimumOutputAmount)-total).toString())};
    }
    throw unavailable('Network costs changed while preparing the quote. Please try again.');
  }
}
function unavailable(message:string){return new TradingEngineError('TRADE_FEE_MISMATCH',message,true);}
