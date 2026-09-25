import { TransactionMessage, type VersionedTransaction } from "@solana/web3.js";
import type { SolanaLookupTableResolver } from "../../trading/application/solana-trade-transaction-validator.js";
import { sponsorError } from "./fee-payer-domain.js";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const DFLOW = "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH";

/** Additional sponsor-authority boundary; domain validators still verify user economics. */
export function sponsorInstructionPolicy(resolver: SolanaLookupTableResolver) {
  return async (tx: VersionedTransaction): Promise<void> => {
    const payer = tx.message.staticAccountKeys[0]!;
    const tables = await resolver.resolve(tx.message.addressTableLookups.map(x => x.accountKey.toBase58()));
    const instructions = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [...tables] }).instructions;
    let routes = 0;
    for (const instruction of instructions) {
      if (!instruction.keys.some(k => k.pubkey.equals(payer))) continue;
      const program = instruction.programId.toBase58();
      if (program === ATA && instruction.data.length === 1 && instruction.data[0] === 1
        && instruction.keys[0]?.pubkey.equals(payer) && instruction.keys.filter(k => k.pubkey.equals(payer)).length === 1) continue;
      // Only the pinned DFlow router may receive the sponsor through CPI.
      // Simulation bounds estimated debit, NOT an on-chain spending allowance.
      if (program === DFLOW && ++routes === 1) continue;
      throw sponsorError("The transaction gives the gas wallet authority to an unapproved instruction.");
    }
  };
}
