/** Read the explicit block height, never absoluteSlot: skipped slots make them differ.
 * Some public RPCs return a slot from getBlockHeight. getEpochInfo provides both
 * named fields and avoids a second request on the signing critical path.
 */
export function epochBlockHeight(value: unknown): bigint {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Solana epoch info.");
  const { blockHeight, absoluteSlot } = value as Record<string, unknown>;
  if (typeof blockHeight !== "number" || !Number.isSafeInteger(blockHeight) || blockHeight < 0
    || typeof absoluteSlot !== "number" || !Number.isSafeInteger(absoluteSlot) || absoluteSlot < blockHeight) {
    throw new Error("Invalid Solana epoch block height.");
  }
  return BigInt(blockHeight);
}
