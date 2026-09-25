import { parseExactDecimal } from './exact-decimal.js';
import { TradingEngineError } from '../../trading/domain/trading.js';
import type { NativeFeePrice } from '../../wallet/fee-payer/fee-usd-valuation.js';
import { NO_FEE_BENEFITS, type FeeBenefits } from './fee-promotions.js';

export const SERVICE_FEE_BPS = 25;
export const NETWORK_FEE_MULTIPLIER_BPS = 15_000;
export const MINIMUM_NETWORK_FEE_CENTS = 1n;
export const FIXED_RENT_CENTS = 15n;
export const FEE_QUOTE_REFRESH_MS = 5_000;

/** Serialized, immutable review terms. All money uses decimal strings/base units. */
export interface TransactionFeeQuote {
  readonly version: 'SERVICE_NETWORK_V1';
  readonly serviceFeeBps: number;
  readonly serviceFeeBaseUnits: string;
  readonly networkFeeBaseUnits: string;
  readonly totalFeeBaseUnits: string;
  readonly estimatedNetworkLamports: string;
  readonly estimatedRentLamports: string;
  readonly estimatedPayerDebitLamports: string;
  readonly networkMultiplierBps: number;
  readonly rentPolicy?: 'FIXED_USD_015';
  readonly rentChargeBaseUnits?: string;
  readonly price: NativeFeePrice;
  readonly quotedAt: string;
  readonly refreshAfterMs: number;
  readonly benefits?: FeeBenefits;
}

export function serviceFeeUnits(grossUsdc: bigint, operation: 'BUY'|'SELL'|'WITHDRAW', benefits: FeeBenefits = NO_FEE_BENEFITS): bigint {
  if(grossUsdc<=0n)throw invalidFees();
  // Service fee rounds down to one USDC base unit; Withdraw has no service fee.
  if(!Number.isSafeInteger(benefits.serviceDiscountPercent)||benefits.serviceDiscountPercent<0||benefits.serviceDiscountPercent>100)throw invalidFees();
  return operation==='WITHDRAW'?0n:grossUsdc*BigInt(SERVICE_FEE_BPS)*BigInt(100-benefits.serviceDiscountPercent)/1_000_000n;
}

export function networkChargeUnits(lamports: bigint, usdPerSol: string, usdcDecimals=6, hasRent=false): bigint {
  if(lamports<0n||!Number.isSafeInteger(usdcDecimals)||usdcDecimals<2||usdcDecimals>18)throw invalidFees();
  const price=parseExactDecimal(usdPerSol);
  if(price.coefficient<=0n||price.scale>30)throw invalidFees();
  const numerator=lamports*price.coefficient*100n*BigInt(NETWORK_FEE_MULTIPLIER_BPS);
  const denominator=1_000_000_000n*(10n**BigInt(price.scale))*10_000n;
  // Round half up, then apply the one-cent minimum for all three operations.
  // Original gas/price precision stays in the snapshot for reconciliation.
  const cents=(2n*numerator+denominator)/(2n*denominator)+(hasRent?FIXED_RENT_CENTS:0n);
  const chargedCents=cents<MINIMUM_NETWORK_FEE_CENTS?MINIMUM_NETWORK_FEE_CENTS:cents;
  return chargedCents*(10n**BigInt(usdcDecimals-2));
}

export function transactionFeeQuote(input:{operation:'BUY'|'SELL'|'WITHDRAW';grossUsdc:bigint;networkLamports:bigint;
  payerDebitLamports:bigint;price:NativeFeePrice;now:Date;usdcDecimals?:number;benefits?:FeeBenefits}):TransactionFeeQuote {
  if(input.networkLamports<0n||input.payerDebitLamports<0n)throw invalidFees();
  // Simulation's payer debit already includes network fee. Refunds are netted.
  const debit=input.payerDebitLamports>input.networkLamports?input.payerDebitLamports:input.networkLamports;
  const benefits=input.benefits??NO_FEE_BENEFITS;
  const service=serviceFeeUnits(input.grossUsdc,input.operation,benefits);
  const hasRent=debit>input.networkLamports;
  const network=networkChargeUnits(input.networkLamports,input.price.usdPerSol,input.usdcDecimals,hasRent&&!benefits.rentWaived);
  if(service+network>=input.grossUsdc)throw new TradingEngineError('TRADE_FEE_MISMATCH','Amount must exceed the service and network fees.',true);
  return {version:'SERVICE_NETWORK_V1',serviceFeeBps:input.operation==='WITHDRAW'?0:SERVICE_FEE_BPS,
    serviceFeeBaseUnits:service.toString(),networkFeeBaseUnits:network.toString(),totalFeeBaseUnits:(service+network).toString(),
    estimatedNetworkLamports:input.networkLamports.toString(),estimatedRentLamports:(debit-input.networkLamports).toString(),
    estimatedPayerDebitLamports:debit.toString(),networkMultiplierBps:NETWORK_FEE_MULTIPLIER_BPS,
    benefits,
    rentPolicy:'FIXED_USD_015',rentChargeBaseUnits:(hasRent&&!benefits.rentWaived?FIXED_RENT_CENTS*10n**BigInt((input.usdcDecimals??6)-2):0n).toString(),
    price:input.price,quotedAt:input.now.toISOString(),refreshAfterMs:FEE_QUOTE_REFRESH_MS};
}
function invalidFees(){return new TradingEngineError('TRADE_FEE_MISMATCH','The fee estimate is invalid.',true);}
