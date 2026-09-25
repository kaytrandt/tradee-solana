import type { Pool, PoolClient } from 'pg';
import type { FeeBenefitContext, FeeBenefits, FeePromotions } from '../domain/fee-promotions.js';
import { NO_FEE_BENEFITS } from '../domain/fee-promotions.js';
import { TradingEngineError } from '../../trading/domain/trading.js';

/** A lease is preview-only; durable SIGNED references pin it until receipt settlement.
 * Only successful receipts with actual account costs consume a free-rent use.
 */
export class PostgresFeePromotions implements FeePromotions {
  constructor(private readonly pool: Pool) {}
  async serviceDiscountPercent(userId: string): Promise<number> {
    const row=await campaignForUser(this.pool,userId);
    return row?.eligible&&row.referral?Number(row.discount):0;
  }
  async benefits(context: FeeBenefitContext, hasRent: boolean): Promise<FeeBenefits> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='3s'");
      await lockPromoUser(c, context.userId);
      const row=await campaignForUser(c,context.userId);
      if (!row?.eligible) { await c.query('COMMIT'); return NO_FEE_BENEFITS; }
      let rentWaived=false;
      if (hasRent) {
        const counts=(await c.query<{used:string}>(`SELECT COUNT(*)::text AS used
          FROM fee_promo_reservations r LEFT JOIN fee_payer_transactions j ON j.reference_id=r.reference_id
          LEFT JOIN trade_orders t ON r.reference_id='tradee:'||t.id::text
          LEFT JOIN withdrawals w ON r.reference_id='tradee-withdraw:'||w.id::text
          WHERE r.user_id=$1 AND r.reference_id<>$2 AND (
            j.state='SIGNED' OR (j.state='CONFIRMED' AND (j.actual_payer_debit_lamports IS NULL
              OR j.actual_network_fee_lamports IS NULL OR j.actual_payer_debit_lamports>j.actual_network_fee_lamports))
            OR ((j.state IS NULL OR j.state='PREPARED') AND r.expires_at>clock_timestamp()
              AND COALESCE(t.state,'CREATED') NOT IN ('FAILED','CANCELLED','EXPIRED')
              AND COALESCE(w.status,'CREATED') NOT IN ('FAILED','CANCELLED','EXPIRED'))
          )`,[context.userId,context.referenceId])).rows[0]!;
        if (BigInt(counts.used)<BigInt(row.uses)) {
          // Repeated calls for this exact unsigned quote extend its lease, not its usage.
          const reserved = await c.query(`INSERT INTO fee_promo_reservations(reference_id,user_id,expires_at)
            VALUES($1,$2,clock_timestamp()+interval '2 minutes') ON CONFLICT(reference_id) DO UPDATE
            SET expires_at=EXCLUDED.expires_at WHERE fee_promo_reservations.user_id=EXCLUDED.user_id
            RETURNING reference_id`,[context.referenceId,context.userId]);
          rentWaived=reserved.rows.length===1;
        }
      } else { await releaseUnsigned(c, context); }
      await c.query('COMMIT');
      return {serviceDiscountPercent:row.referral?Number(row.discount):0,rentWaived};
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async release(context: FeeBenefitContext): Promise<void> {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='3s'");
      await lockPromoUser(c,context.userId);
      await releaseUnsigned(c,context);
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
}
async function campaignForUser(c: Pick<Pool,'query'>, userId: string) {
  return (await c.query<{eligible:boolean;referral:boolean;uses:string;discount:string}>(`
    SELECT u.created_at>=campaign.started_at AND NOT u.is_demo
      AND COALESCE((SELECT value FROM admin_config WHERE key='promo.enabled'),'false')='true' AS eligible,
      EXISTS(SELECT 1 FROM referral_relationships r WHERE r.referred_user_id=u.id)
      AND clock_timestamp()<u.created_at + (COALESCE((SELECT value FROM admin_config WHERE key='promo.referralDays'),'30')||' days')::interval AS referral,
      COALESCE((SELECT value FROM admin_config WHERE key='promo.rentUses'),'2') AS uses,
      COALESCE((SELECT value FROM admin_config WHERE key='promo.serviceDiscountPercent'),'20') AS discount
    FROM tradee_users u CROSS JOIN fee_promo_campaign campaign WHERE u.id=$1`,[userId])).rows[0];
}
async function releaseUnsigned(c: PoolClient, context: FeeBenefitContext): Promise<void> {
  await c.query(`DELETE FROM fee_promo_reservations r WHERE reference_id=$1 AND user_id=$2
    AND NOT EXISTS(SELECT 1 FROM fee_payer_transactions j WHERE j.reference_id=r.reference_id AND j.state<>'PREPARED')`,[context.referenceId,context.userId]);
}
export async function lockPromoUser(c: PoolClient, userId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('tradee:fee-promo:'||$1,0))",[userId]);
}
/** Called inside the same transaction that commits signed bytes, before broadcast. */
export async function requireRentReservation(c: PoolClient, context: FeeBenefitContext): Promise<void> {
  await lockPromoUser(c,context.userId);
  const row=(await c.query(`SELECT reference_id FROM fee_promo_reservations
    WHERE reference_id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR UPDATE`,[context.referenceId,context.userId])).rows[0];
  if (!row) throw new TradingEngineError('TRADE_TRANSACTION_EXPIRED','The reviewed transaction has expired.',true);
}
