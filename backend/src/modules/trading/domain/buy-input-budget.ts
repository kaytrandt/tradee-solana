/** The reviewed gross amount caps the wallet debit, including the exact fee.
 * A route may leave input unspent in the user's wallet, but must spend a
 * positive amount on the swap. Output and fee checks remain mandatory.
 */
export function isBuyDebitWithinBudget(debit: bigint, grossInput: bigint, fee: bigint): boolean {
  return fee >= 0n && debit > fee && debit <= grossInput;
}
