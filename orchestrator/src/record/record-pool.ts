// concern: record-pool
/** Owns bounded, process-wide record Postgres pools. Must not know tenant or query policy. */
import { SQL } from 'bun'

const RECORD_POOL_MAX = 10
const RECORD_POOL_IDLE_TIMEOUT_SECONDS = 30

const pools = new Map<string, SQL>()

export function recordPool(url: string, max = RECORD_POOL_MAX): SQL {
  const existing = pools.get(url)
  if (existing) return existing
  const pool = new SQL(url, { max, idleTimeout: RECORD_POOL_IDLE_TIMEOUT_SECONDS })
  pools.set(url, pool)
  return pool
}

export async function closeRecordPools(): Promise<void> {
  const closing = [...pools.values()]
  pools.clear()
  await Promise.all(closing.map((pool) => pool.close()))
}
