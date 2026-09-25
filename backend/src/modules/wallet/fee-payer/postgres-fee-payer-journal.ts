import type { Pool, PoolClient } from "pg";
import { requireRentReservation } from '../../transaction-policy/infrastructure/postgres-fee-promotions.js';
import { sameRequest, sponsorError, type FeePayerJournal, type FeePayerLimits, type FeePayerRecord } from "./fee-payer-domain.js";

interface Row { request: FeePayerRecord["request"]; payer_address: string; request_expiry: string; reserved_lamports: string;
  state: FeePayerRecord["state"]; signed_transaction: string | null; signature: string | null; fee_valuation?: FeePayerRecord["feeValuation"]; }
function decode(row: Row): FeePayerRecord {
  return { request: row.request, payer: row.payer_address, requestExpiry: Number(row.request_expiry), reservedLamports: row.reserved_lamports,
    state: row.state, signedTransaction: row.signed_transaction, signature: row.signature, feeValuation: row.fee_valuation ?? null };
}
export class PostgresFeePayerJournal implements FeePayerJournal {
  constructor(private readonly pool: Pool, private readonly allowUninstalledSchema = false) {}
  async get(referenceId: string): Promise<FeePayerRecord | null> {
    let row: Row | undefined;
    try { row = (await this.pool.query<Row>("SELECT * FROM fee_payer_transactions WHERE reference_id=$1", [referenceId])).rows[0]; }
    catch (error) {
      // Rolling rollout: disabled new code may run before the additive migration.
      // Never swallow connection/permission errors or tolerate missing schema while enabled.
      if (this.allowUninstalledSchema && (error as { code?: string }).code === "42P01") return null;
      throw error;
    }
    return row ? decode(row) : null;
  }
  async prepare(record: FeePayerRecord): Promise<FeePayerRecord> {
    await this.pool.query(`INSERT INTO fee_payer_transactions(reference_id,user_id,wallet_id,payer_address,request,request_expiry,reserved_lamports,state)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'PREPARED') ON CONFLICT (reference_id) DO UPDATE
      SET request_expiry=EXCLUDED.request_expiry, reserved_lamports=EXCLUDED.reserved_lamports
      WHERE fee_payer_transactions.state='PREPARED' AND fee_payer_transactions.request=EXCLUDED.request
        AND fee_payer_transactions.payer_address=EXCLUDED.payer_address
        AND (fee_payer_transactions.request_expiry <= (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint
          OR fee_payer_transactions.reserved_lamports <> EXCLUDED.reserved_lamports)`,
    [record.request.referenceId, record.request.feePayerContext!.userId, record.request.walletId, record.payer,
      JSON.stringify(record.request), record.requestExpiry, record.reservedLamports]);
    const existing = await this.get(record.request.referenceId);
    if (!existing || !sameRequest(existing.request, record.request) || existing.payer !== record.payer) throw sponsorError("Sponsorship reference already belongs to another transaction.");
    return existing;
  }
  async commitSigned(record: FeePayerRecord, limits: FeePayerLimits, readBalance: () => Promise<bigint>): Promise<FeePayerRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('tradee:fee-payer:budget', 0))");
      const row = (await client.query<Row>("SELECT * FROM fee_payer_transactions WHERE reference_id=$1 FOR UPDATE", [record.request.referenceId])).rows[0];
      if (!row) throw sponsorError("Sponsorship authorization was not prepared.");
      const current = decode(row);
      if (!sameRequest(current.request, record.request) || current.payer !== record.payer
        || current.reservedLamports !== record.reservedLamports || current.requestExpiry !== record.requestExpiry) throw sponsorError("Sponsorship authorization changed.");
      if (current.signature !== null) {
        if (current.signature !== record.signature || current.signedTransaction !== record.signedTransaction) throw sponsorError("A different signed transaction already owns this reference.");
        await client.query("COMMIT"); return current;
      }
      if(record.request.feePayerContext?.rentWaived)await requireRentReservation(client,{
        userId:record.request.feePayerContext.userId,referenceId:record.request.referenceId});
      // Pending signatures keep their full allowance indefinitely. Settled
      // receipts consume actual payer cost, never an estimated policy ceiling.
      // Missing historical cost remains reserved; refunds cannot fund new spend.
      const spend = (await client.query<{ total: string; own: string }>(`SELECT COALESCE(SUM(cost),0)::text AS total,
        COALESCE(SUM(cost) FILTER (WHERE user_id=$1),0)::text AS own FROM (
          SELECT user_id, CASE WHEN state='SIGNED' THEN reserved_lamports
            ELSE GREATEST(COALESCE(actual_payer_debit_lamports,reserved_lamports),0) END AS cost
          FROM fee_payer_transactions WHERE signed_at > NOW()-INTERVAL '24 hours' OR state='SIGNED'
        ) AS usage`, [record.request.feePayerContext!.userId])).rows[0]!;
      const cost = BigInt(record.reservedLamports);
      if (BigInt(spend.total) + cost > limits.globalDailyLamports || BigInt(spend.own) + cost > limits.userDailyLamports) throw sponsorError("The gas sponsorship budget has been reached.");
      // Observe pending reservations BEFORE reading the chain while holding the
      // admission lock. A concurrent settlement may remove a row afterwards,
      // but cannot cause this admission to forget its debit. Double-counting a
      // recently landed pending transaction is conservative and temporary.
      const pending = (await client.query<{ amount: string }>(`SELECT COALESCE(SUM(reserved_lamports),0)::text AS amount
        FROM fee_payer_transactions WHERE payer_address=$1 AND state='SIGNED'`, [record.payer])).rows[0]!;
      const balance = await readBalance();
      if (balance < BigInt(pending.amount) + cost + limits.minimumBalanceLamports) {
        throw sponsorError("The gas wallet balance is reserved by pending transactions.");
      }
      const updated = await client.query<Row>(`UPDATE fee_payer_transactions SET state='SIGNED', signed_transaction=$2,signature=$3,signed_at=NOW(),fee_valuation=$4::jsonb
        WHERE reference_id=$1 AND state='PREPARED' AND request_expiry > (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint RETURNING *`,
      [record.request.referenceId, record.signedTransaction, record.signature, JSON.stringify(record.feeValuation ?? null)]);
      if (!updated.rows[0]) throw sponsorError("Gas sponsorship authorization expired before signing completed.");
      await client.query("COMMIT"); return decode(updated.rows[0]);
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }
  async settle(referenceId: string, state: "CONFIRMED" | "FAILED", fee: string, debit: string): Promise<void> {
    await this.pool.query(`UPDATE fee_payer_transactions SET state=$2,actual_network_fee_lamports=$3,actual_payer_debit_lamports=$4,settled_at=NOW(),
      actual_network_fee_usd=CASE WHEN fee_valuation->>'status'='AVAILABLE'
        THEN $3::numeric * (fee_valuation->'price'->>'usdPerSol')::numeric * 0.000000001 END,
      actual_payer_debit_usd=CASE WHEN fee_valuation->>'status'='AVAILABLE'
        THEN $4::numeric * (fee_valuation->'price'->>'usdPerSol')::numeric * 0.000000001 END
      WHERE reference_id=$1 AND state='SIGNED'`, [referenceId, state, fee, debit]);
  }
}
async function rollback(client: PoolClient): Promise<void> { try { await client.query("ROLLBACK"); } catch { /* preserve original error */ } }
