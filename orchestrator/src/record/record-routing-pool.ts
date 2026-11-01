// concern: record-routing-pool
/** Pulls bounded pages of hosted routing evidence into the local pool. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordRoutingEvidence } from './record-routing-evidence-contract.ts'

export const ROUTING_POOL_PAGE_LIMIT = 100
export const ROUTING_POOL_PAGES_PER_SYNC = 5
const ROUTING_POOL_CURSOR = 'record_routing_pool_seq'

function readCursor(local: Database, key: string): string | undefined {
  return local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(key)?.value
}

function writeCursor(local: Database, key: string, value: string): void {
  local
    .query(
      'INSERT INTO schema_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value)
}

export type RoutingPoolPullResult = {
  added: number
  updated: number
  caughtUp: boolean
}

function upsertPoolRun(local: Database, row: RecordRoutingEvidence, pulledAt: string): void {
  local
    .query(
      `INSERT INTO routing_pool_run (
         record_id,space_id,agent,model,job,stack,prompt_bytes,status,failure_kind,executor,
         evidence_excluded,started_at,latency_ms,vendor_tokens,model_calls,peak_call_tokens,
         delivery,quality,fidelity,pulled_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(record_id) DO UPDATE SET
         space_id=excluded.space_id,
         agent=excluded.agent,
         model=excluded.model,
         job=excluded.job,
         stack=excluded.stack,
         prompt_bytes=excluded.prompt_bytes,
         status=excluded.status,
         failure_kind=excluded.failure_kind,
         executor=excluded.executor,
         evidence_excluded=excluded.evidence_excluded,
         started_at=excluded.started_at,
         latency_ms=excluded.latency_ms,
         vendor_tokens=excluded.vendor_tokens,
         model_calls=excluded.model_calls,
         peak_call_tokens=excluded.peak_call_tokens,
         delivery=excluded.delivery,
         quality=excluded.quality,
         fidelity=excluded.fidelity,
         pulled_at=excluded.pulled_at`,
    )
    .run(
      row.id,
      row.spaceId,
      row.agent,
      row.model,
      row.job,
      row.stack,
      row.promptBytes,
      row.status,
      row.failureKind,
      row.executor,
      row.evidenceExcluded,
      row.startedAt,
      row.latencyMs,
      row.vendorTokens,
      row.modelCalls,
      row.peakCallTokens,
      row.delivery,
      row.quality,
      row.fidelity,
      pulledAt,
    )
  local.query('DELETE FROM routing_pool_lens WHERE run_record_id=?').run(row.id)
  const insertLens = local.query(
    'INSERT INTO routing_pool_lens (record_id,run_record_id,lens) VALUES (?,?,?)',
  )
  for (const lens of row.lenses) insertLens.run(newRecordId(), row.id, lens)
}

export async function pullRoutingPool(
  local: Database,
  spaces: readonly string[],
): Promise<RoutingPoolPullResult> {
  const client = recordApiClient()
  let added = 0
  let updated = 0
  let caughtUp = true
  for (const spaceId of spaces) {
    const cursorKey = `${ROUTING_POOL_CURSOR}:${spaceId}`
    let requestCursor = readCursor(local, cursorKey)
    let spaceCaughtUp = false
    for (let pageNumber = 0; pageNumber < ROUTING_POOL_PAGES_PER_SYNC; pageNumber++) {
      const page = await client.listRoutingEvidence({
        spaceId,
        cursor: requestCursor,
        limit: ROUTING_POOL_PAGE_LIMIT,
      })
      writeTransaction(() => {
        const pulledAt = nowIso()
        for (const row of page.items) {
          const exists = local
            .query<{ present: number }, [string]>(
              'SELECT 1 AS present FROM routing_pool_run WHERE record_id=?',
            )
            .get(row.id)
          upsertPoolRun(local, row, pulledAt)
          if (exists) updated++
          else added++
        }
        const pageCursor = page.endCursor ?? page.nextCursor
        if (pageCursor) {
          writeCursor(local, cursorKey, pageCursor)
        }
      }, local)
      if (!page.nextCursor) {
        spaceCaughtUp = true
        break
      }
      requestCursor = page.nextCursor
    }
    if (!spaceCaughtUp) caughtUp = false
  }
  return { added, updated, caughtUp }
}
