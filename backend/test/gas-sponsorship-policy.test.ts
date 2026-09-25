import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryGasSponsorshipPolicy } from "../src/modules/trading/application/gas-sponsorship-policy.js";

test("gas sponsorship fails closed when disabled and enforces user/wallet/global limits", async () => {
  const disabled = new InMemoryGasSponsorshipPolicy({
    enabled: false, windowMs: 60_000, perUserLimit: 1, perWalletLimit: 1, globalLimit: 1,
  });
  assert.deepEqual(await disabled.evaluate({ userId: "u", walletId: "w", orderId: "o" }), {
    eligible: false, reason: "disabled",
  });

  let now = 1_000;
  const policy = new InMemoryGasSponsorshipPolicy({
    enabled: true, windowMs: 1_000, perUserLimit: 1, perWalletLimit: 1, globalLimit: 2,
  }, () => now);
  assert.equal((await policy.evaluate({ userId: "u1", walletId: "w1", orderId: "o1" })).eligible, true);
  assert.equal((await policy.evaluate({ userId: "u1", walletId: "w1", orderId: "o1" })).eligible, true,
    "idempotent retries must not consume a second sponsorship slot");
  assert.deepEqual(await policy.evaluate({ userId: "u1", walletId: "w2", orderId: "o2" }), {
    eligible: false, reason: "rate_limited",
  });
  now += 1_001;
  assert.equal((await policy.evaluate({ userId: "u1", walletId: "w2", orderId: "o2" })).eligible, true);
});

test('Postgres speculative eligibility is read-only, checks limits and reserves no admission slots', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PostgresGasSponsorshipPolicy } = await import('../src/modules/trading/infrastructure/postgres/postgres-gas-sponsorship-policy.js');
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sponsorship_admissions(order_id text,user_id text,wallet_id text,admitted_at timestamptz,expires_at timestamptz)`);
    const policy = new PostgresGasSponsorshipPolicy(db as unknown as import('pg').Pool,
      { enabled: true, windowMs: 60_000, perUserLimit: 1, perWalletLimit: 1, globalLimit: 2 });
    for (let i = 0; i < 20; i++) assert.equal((await policy.inspect({ orderId: `order-${i}`, userId: 'user', walletId: 'wallet' })).eligible, true);
    assert.equal((await db.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM sponsorship_admissions')).rows[0]!.count, 0);
    await db.exec(`INSERT INTO sponsorship_admissions VALUES ('admitted','user','wallet',NOW(),NOW()+INTERVAL '1 hour')`);
    assert.equal((await policy.inspect({ orderId: 'new', userId: 'user', walletId: 'wallet' })).eligible, false);
    assert.equal((await policy.inspect({ orderId: 'admitted', userId: 'user', walletId: 'wallet' })).eligible, true);
    assert.equal((await policy.inspect({ orderId: 'admitted', userId: 'other', walletId: 'wallet' })).eligible, false);
  } finally { await db.close(); }
});
