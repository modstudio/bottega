// concern: record-pool
/** Owns bounded, process-wide record Postgres pools. Must not know tenant or query policy. */
import { SQL } from 'bun'
import { recordServiceUrl } from '../../../shared/record/service-connection.ts'

const RECORD_POOL_MAX = 10
export const RECORD_POOL_IDLE_TIMEOUT_SECONDS = 30

const pools = new Map<string, { pool: SQL; max: number }>()

export function recordPool(url: string, max = RECORD_POOL_MAX): SQL {
  const existing = pools.get(url)
  if (existing) {
    if (existing.max !== max) {
      throw new Error(
        `record pool for this URL already holds max ${existing.max}, not ${max}; call closeRecordPools() before changing its bound`,
      )
    }
    return existing.pool
  }
  const pool = new SQL(recordServiceUrl(url), {
    max,
    idleTimeout: RECORD_POOL_IDLE_TIMEOUT_SECONDS,
  })
  pools.set(url, { pool, max })
  return pool
}

export async function closeRecordPools(): Promise<void> {
  const closing = [...pools.values()]
  pools.clear()
  await Promise.all(closing.map(({ pool }) => pool.close()))
}
