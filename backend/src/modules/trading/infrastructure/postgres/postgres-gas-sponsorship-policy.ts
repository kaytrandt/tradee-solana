import type { Pool } from "pg";
import type { GasSponsorshipPolicy } from "../../domain/trading.js";
import type { GasSponsorshipPolicyConfiguration } from "../../application/gas-sponsorship-policy.js";

/** Shared sliding-window admission policy for both trading and withdrawals.
 * Admission is deliberately charged at authorization preparation, not a promise
 * of actual gas spend. A DB failure fails closed rather than resetting limits.
 */
export class PostgresGasSponsorshipPolicy implements GasSponsorshipPolicy {
  constructor(private readonly pool: Pool, private readonly configuration: GasSponsorshipPolicyConfiguration) {}
  async inspect(input: { readonly userId: string; readonly walletId: string; readonly orderId: string }) {
    if (!this.configuration.enabled) return { eligible: false, reason: "disabled" } as const;
    const existing = (await this.pool.query<{ user_id: string; wallet_id: string }>(
      "SELECT user_id, wallet_id FROM sponsorship_admissions WHERE order_id=$1 AND expires_at>NOW()", [input.orderId])).rows[0];
    if (existing) return existing.user_id === input.userId && existing.wallet_id === input.walletId
      ? { eligible: true, reason: "eligible" } as const : { eligible: false, reason: "rate_limited" } as const;
    const counts = await this.pool.query<{ allowed: boolean }>(
      `SELECT COUNT(*) < $4 AND COUNT(*) FILTER (WHERE user_id=$1) < $5
        AND COUNT(*) FILTER (WHERE wallet_id=$2) < $6 AS allowed
       FROM sponsorship_admissions WHERE admitted_at > NOW() - $3::bigint * INTERVAL '1 millisecond'`,
      [input.userId,input.walletId,this.configuration.windowMs,this.configuration.globalLimit,
        this.configuration.perUserLimit,this.configuration.perWalletLimit]);
    return counts.rows[0]?.allowed === true ? { eligible: true, reason: "eligible" } as const
      : { eligible: false, reason: "rate_limited" } as const;
  }
  async evaluate(input: { readonly userId: string; readonly walletId: string; readonly orderId: string }) {
    if (!this.configuration.enabled) return { eligible: false, reason: "disabled" } as const;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('tradee:sponsorship:admission', 0))");
      const existing = await client.query<{ user_id: string; wallet_id: string }>(
        "SELECT user_id, wallet_id FROM sponsorship_admissions WHERE order_id = $1 AND expires_at > NOW()", [input.orderId]);
      const row = existing.rows[0];
      if (row !== undefined) {
        await client.query("COMMIT");
        return row.user_id === input.userId && row.wallet_id === input.walletId
          ? { eligible: true, reason: "eligible" } as const
          : { eligible: false, reason: "rate_limited" } as const;
      }
      await client.query("DELETE FROM sponsorship_admissions WHERE expires_at <= NOW()");
      const counts = await client.query<{ allowed: boolean }>(
        `SELECT COUNT(*) < $4 AND COUNT(*) FILTER (WHERE user_id = $1) < $5
           AND COUNT(*) FILTER (WHERE wallet_id = $2) < $6 AS allowed
         FROM sponsorship_admissions WHERE admitted_at > NOW() - $3::bigint * INTERVAL '1 millisecond'`,
        [input.userId, input.walletId, this.configuration.windowMs, this.configuration.globalLimit,
          this.configuration.perUserLimit, this.configuration.perWalletLimit]);
      if (counts.rows[0]?.allowed !== true) {
        await client.query("COMMIT");
        return { eligible: false, reason: "rate_limited" } as const;
      }
      await client.query(`INSERT INTO sponsorship_admissions(order_id, user_id, wallet_id, admitted_at, expires_at)
        VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '24 hours')`, [input.orderId, input.userId, input.walletId]);
      await client.query("COMMIT");
      return { eligible: true, reason: "eligible" } as const;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
