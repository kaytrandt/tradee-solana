import type { Pool } from "pg";

/** Atomic account-wide slot reservation across price/statistics jobs and replicas. */
export class PostgresJupiterRequestGate {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async reserve(intervalMs: number): Promise<number> {
    const result = await this.pool.query<{ wait_ms: number }>(`INSERT INTO jupiter_request_budget(id, next_request_at)
      VALUES (true, clock_timestamp() + $1::integer * interval '1 millisecond')
      ON CONFLICT (id) DO UPDATE SET next_request_at = greatest(jupiter_request_budget.next_request_at, clock_timestamp())
        + $1::integer * interval '1 millisecond'
      RETURNING greatest(0, ceil(extract(epoch FROM (next_request_at - clock_timestamp())) * 1000) - $1::integer)::integer AS wait_ms`, [intervalMs]);
    return result.rows[0]?.wait_ms ?? 0;
  }
}
