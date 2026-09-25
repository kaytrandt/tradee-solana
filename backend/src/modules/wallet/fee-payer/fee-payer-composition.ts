import type { Pool } from "pg";
import type { SponsoredTransactionProvider } from "../../trading/domain/trading.js";
import { SolanaAddressLookupResolver } from "../../trading/infrastructure/solana/solana-address-lookup-resolver.js";
import { solanaRpcExecutionConfiguration } from "../../trading/infrastructure/solana/solana-rpc-execution-gateway.js";
import { CoSignTransactionProvider, RoutedSponsoredTransactionProvider } from "./co-sign-transaction-provider.js";
import { canonicalAddress, FeePayerSigner } from "./fee-payer-signer.js";
import { type FeePayerLimits } from "./fee-payer-domain.js";
import { PostgresFeePayerJournal } from "./postgres-fee-payer-journal.js";
import { PrivyUserTransactionSigner } from "./privy-user-transaction-signer.js";
import { SolanaFeePayerChain } from "./solana-fee-payer-chain.js";
import { sponsorInstructionPolicy } from "./sponsor-instruction-policy.js";
import { nativeFeePriceSource } from "./fee-price-composition.js";
type Environment = Readonly<Record<string, string | undefined>>;
export function feePayerConfiguration(env: Environment) {
  const enabled = env.TRADEE_FEE_PAYER_ENABLED === "true";
  const address = env.TRADEE_FEE_PAYER_PUBLIC_KEY?.trim();
  if (enabled && !address) throw new Error("TRADEE_FEE_PAYER_PUBLIC_KEY is required before enabling co-sign.");
  const limits: FeePayerLimits = {
    swapNetworkLamports: amount(env, "SWAP_MAX_NETWORK_LAMPORTS", "5000000"),
    swapRentLamports: amount(env, "SWAP_MAX_RENT_LAMPORTS", "5000000"),
    withdrawNetworkLamports: amount(env, "WITHDRAW_MAX_NETWORK_LAMPORTS", "2000000"),
    withdrawRentLamports: amount(env, "WITHDRAW_MAX_RENT_LAMPORTS", "2500000"),
    minimumBalanceLamports: amount(env, "MIN_BALANCE_LAMPORTS", "5000000"),
    globalDailyLamports: amount(env, "GLOBAL_DAILY_LAMPORTS", "500000000"),
    userDailyLamports: amount(env, "USER_DAILY_LAMPORTS", "50000000"),
  };
  const priority = amount(env, "SWAP_PRIORITY_LAMPORTS", "100000");
  if (priority > 4_294_967_295n || priority + 10_000n > limits.swapNetworkLamports) throw new Error("Swap priority fee must fit the network fee ceiling including two signatures.");
  return { enabled, address: address ? canonicalAddress(address) : undefined, limits, priorityLamports: priority.toString() };
}
export function withTradeeFeePayer(pool: Pool, env: Environment, legacy: SponsoredTransactionProvider): SponsoredTransactionProvider {
  const config = feePayerConfiguration(env);
  // Disabling new signatures must NOT disable recovery of previously signed bytes.
  if (!config.address) return legacy;
  if (!config.address) throw new Error("Gas payer public address is required for recovery.");
  const journal = new PostgresFeePayerJournal(pool, !config.enabled);
  const signer = config.enabled ? new FeePayerSigner(env.TRADEE_FEE_PAYER_PRIVATE_KEY ?? "", config.address) : null;
  const rpc = env.SOLANA_RPC_URL;
  if (!rpc || !env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) throw new Error("Co-sign requires Solana RPC and Privy configuration.");
  const urls = solanaRpcExecutionConfiguration(env).urls;
  const own = new CoSignTransactionProvider(config.address, signer, new PrivyUserTransactionSigner(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET),
    new SolanaFeePayerChain(urls), journal, config.limits, sponsorInstructionPolicy(new SolanaAddressLookupResolver(urls)),
    60_000, nativeFeePriceSource(pool, env, urls));
  return new RoutedSponsoredTransactionProvider(legacy, own, journal);
}
function amount(env: Environment, suffix: string, fallback: string): bigint {
  const value = env[`TRADEE_FEE_PAYER_${suffix}`]?.trim() || fallback;
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new Error(`TRADEE_FEE_PAYER_${suffix} must be a positive integer lamport amount.`);
  return BigInt(value);
}
