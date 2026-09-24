import { createHash } from 'node:crypto'
import { readRecordSessionToken } from '../../shared/record-session.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import type { DayEvidence, IntervalEvidence, IntervalKey } from './hosted-evidence.ts'
import { hostedSignedInUserId } from './task-client.ts'

const TEST_REFUSAL =
  'hub evidence sync refuses a real hosted URL unless a stub is injected in tests'
type SyncFetch = (input: string, init?: RequestInit) => Promise<Response>
type LedgerRow = { local_key: string; content_hash: string }

/** Resolve attribution now; callers persist the result and never infer it during push. */
export async function signedInRecordUserId(
  options: { baseUrl?: string; token?: string | null; fetch?: SyncFetch } = {},
): Promise<string | null> {
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  const token = Object.hasOwn(options, 'token') ? options.token : readRecordSessionToken()
  if (!baseUrl || !token) return null
  return hostedSignedInUserId({ baseUrl, token, fetch: options.fetch })
}

export type SyncTablePlan<T> = {
  changed: Array<{ key: string; hash: string; row: T }>
  deleted: string[]
  deleteSkipped: boolean
  localCount: number
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function diffRows<T>(
  rows: Array<{ key: string; row: T }>,
  ledger: LedgerRow[],
  allowDeletes = true,
): SyncTablePlan<T> {
  const known = new Map(ledger.map((entry) => [entry.local_key, entry.content_hash]))
  const current = new Set(rows.map((entry) => entry.key))
  return {
    changed: rows
      .map((entry) => ({ ...entry, hash: contentHash(entry.row) }))
      .filter((entry) => known.get(entry.key) !== entry.hash),
    deleted:
      rows.length > 0 && allowDeletes ? [...known.keys()].filter((key) => !current.has(key)) : [],
    deleteSkipped: allowDeletes && rows.length === 0 && known.size > 0,
    localCount: rows.length,
  }
}

export function batches<T>(rows: T[], size = 500): T[][] {
  const result: T[][] = []
  for (let index = 0; index < rows.length; index += size)
    result.push(rows.slice(index, index + size))
  return result
}

function intervalKey(row: IntervalEvidence) {
  return JSON.stringify([row.source, row.ref, row.start_at])
}

function localIntervals() {
  const rows = db()
    .query<IntervalEvidence, []>(
      `SELECT task_key, project AS project_name, source, agent, job, start_at, end_at,
              claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id
         FROM interval ORDER BY source, ref, start_at`,
    )
    .all()
  return rows.map((row) => ({ key: intervalKey(row), row }))
}

function localDays() {
  const rows = db()
    .query<DayEvidence, []>(
      `SELECT day, claude_tokens, cache_read, messages, tasks, canon_tokens, other_tokens,
              commits, files, lines_product, lines_test, lines_docs, lines_config,
              lines_generated, collected_at
         FROM day ORDER BY day`,
    )
    .all()
  return rows.map((row) => ({ key: row.day, row }))
}

function ledger(table: string): LedgerRow[] {
  return db()
    .query<LedgerRow, [string]>(
      `SELECT local_key, content_hash FROM record_ledger WHERE table_name=? ORDER BY local_key`,
    )
    .all(table)
}

async function request(
  fetchImpl: SyncFetch,
  baseUrl: string,
  token: string,
  path: string,
  method: string,
  body: unknown,
) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`hub hosted evidence ${response.status}${text ? `: ${text}` : ''}`)
  }
}

function commitLedger<T>(table: string, plan: SyncTablePlan<T>) {
  const syncedAt = nowIso()
  writeTransaction((conn) => {
    const put = conn.query(
      `INSERT INTO record_ledger (table_name, local_key, content_hash, synced_at)
       VALUES (?,?,?,?) ON CONFLICT(table_name, local_key) DO UPDATE SET
       content_hash=excluded.content_hash, synced_at=excluded.synced_at`,
    )
    const remove = conn.query(`DELETE FROM record_ledger WHERE table_name=? AND local_key=?`)
    for (const row of plan.changed) put.run(table, row.key, row.hash, syncedAt)
    for (const key of plan.deleted) remove.run(table, key)
  })
}

export type SyncResult = {
  interval: { changed: number; deleted: number; deleteSkipped: boolean; local: number }
  day: { changed: number; deleted: number; deleteSkipped: boolean; local: number }
}

export async function syncEvidence(
  options: { dryRun?: boolean; baseUrl?: string; token?: string | null; fetch?: SyncFetch } = {},
): Promise<SyncResult> {
  const interval = diffRows(localIntervals(), ledger('interval'))
  const day = diffRows(localDays(), ledger('day'), false)
  const result: SyncResult = {
    interval: {
      changed: interval.changed.length,
      deleted: interval.deleted.length,
      deleteSkipped: interval.deleteSkipped,
      local: interval.localCount,
    },
    day: { changed: day.changed.length, deleted: 0, deleteSkipped: false, local: day.localCount },
  }
  if (options.dryRun) return result
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  if (!baseUrl) throw new Error('HUB_HOSTED_URL is not set')
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token) throw new Error('record session is absent; run `orch record sign-in`')
  const fetchImpl = options.fetch ?? fetch
  for (const group of batches(interval.changed.map((entry) => entry.row)))
    await request(fetchImpl, baseUrl, token, '/v1/evidence/intervals', 'PUT', { rows: group })
  for (const group of batches(
    interval.deleted.map((key) => {
      const values = JSON.parse(key) as [string, string, string]
      return {
        source: values[0],
        ref: values[1],
        start_at: values[2],
      } satisfies IntervalKey
    }),
  ))
    await request(fetchImpl, baseUrl, token, '/v1/evidence/intervals', 'DELETE', { keys: group })
  commitLedger('interval', interval)
  for (const group of batches(day.changed.map((entry) => entry.row)))
    await request(fetchImpl, baseUrl, token, '/v1/evidence/days', 'PUT', { rows: group })
  commitLedger('day', day)
  return result
}

export function printSyncResult(result: SyncResult) {
  for (const table of ['interval', 'day'] as const) {
    const row = result[table]
    console.log(
      `${table.padEnd(9)} ${row.changed} changed, ${row.deleted} deleted, ${row.local} local`,
    )
    if (row.deleteSkipped) console.log(`${table.padEnd(9)} deletes skipped: local table is empty`)
  }
}
