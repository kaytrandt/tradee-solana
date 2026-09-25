import { createPublicKey, verify } from "node:crypto";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { sponsorError } from "./fee-payer-domain.js";

/** Operator-owned gas wallet only. End-user private keys never enter this adapter. */
export class FeePayerSigner {
  #keypair: Keypair;
  constructor(secret: string, expectedAddress: string) {
    try {
      const raw: unknown = secret.trim().startsWith("[") ? JSON.parse(secret) : decodeBase58(secret.trim());
      if (!Array.isArray(raw) || raw.length !== 64 || !raw.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
      const bytes = Uint8Array.from(raw);
      try { this.#keypair = Keypair.fromSecretKey(bytes.slice()); } finally { bytes.fill(0); raw.fill(0); }
      if (this.#keypair.publicKey.toBase58() !== expectedAddress) throw new Error();
    } catch { throw sponsorError("The operator gas key does not match its configured public address."); }
  }
  sign(transaction: VersionedTransaction): void { transaction.sign([this.#keypair]); }
}

export function verifyWalletSignature(transaction: VersionedTransaction, index: number): boolean {
  const address = transaction.message.staticAccountKeys[index];
  const signature = transaction.signatures[index];
  if (!address || !signature || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), address.toBuffer()]), format: "der", type: "spki" });
  return verify(null, transaction.message.serialize(), key, signature);
}

export function encodeBase58(bytes: Uint8Array): string {
  let value = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0")), result = "";
  while (value > 0n) { result = ALPHABET[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = "1" + result; }
  return result;
}
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(value: string): number[] {
  if (value.length < 64 || value.length > 88) throw new Error();
  let n = 0n;
  for (const c of value) { const d = ALPHABET.indexOf(c); if (d < 0) throw new Error(); n = n * 58n + BigInt(d); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of value) { if (c !== "1") break; bytes.unshift(0); }
  return bytes;
}

export function canonicalAddress(value: string): string {
  try { const key = new PublicKey(value); if (!PublicKey.isOnCurve(key.toBytes())) throw new Error(); return key.toBase58(); }
  catch { throw sponsorError("A valid operator gas wallet public address is required."); }
}
