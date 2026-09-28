// concern: outbox-redaction
/** Re-enqueues sanitized copies of already-synced record payloads. Must not know hosted storage. */
import type { Database } from 'bun:sqlite'
import { nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { sanitizeOutboxPayloadForRules } from './outbox-sanitize.ts'

const DEFAULT_SYNCED_REDACTION_RULES = [
  'url-userinfo',
  'bearer',
  'authorization',
  'provider-prefix',
  'assignment',
] as const

const REDACTION_RULES = new Set<string>(DEFAULT_SYNCED_REDACTION_RULES)

type SyncedOutboxRow = {
  id: number
  kind: string
  record_id: string
  payload: string
}

type SyncedRedactionCount = { kind: string; rule: string; count: number }
type SyncedRedactionSkip = { kind: string; recordId: string }
export type SyncedRedactionResult = {
  counts: SyncedRedactionCount[]
  enqueued: number
  wouldEnqueue: number
  skipped: SyncedRedactionSkip[]
  dryRun: boolean
}

export function syncedRedactionRules(value?: string): Set<string> {
  if (value === undefined) return new Set(DEFAULT_SYNCED_REDACTION_RULES)
  const rules = value
    .split(',')
    .map((rule) => rule.trim())
    .filter(Boolean)
  if (rules.length === 0) throw new Error('--rules requires at least one comma-separated rule')
  const unknown = [...new Set(rules.filter((rule) => !REDACTION_RULES.has(rule)))]
  if (unknown.length > 0) {
    throw new Error(
      `rule${unknown.length === 1 ? '' : 's'} not approved for synced redaction: ${unknown.join(', ')}; choose from ${[...REDACTION_RULES].join(', ')}`,
    )
  }
  return new Set(rules)
}

function parsePayload(row: SyncedOutboxRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.payload)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // The refusal below deliberately omits payload text.
  }
  throw new Error(
    `refusing synced outbox redaction: outbox row ${row.id} has an unreadable payload\n` +
      'invariant: Redaction never reports success for a payload it could not inspect.\n' +
      `cleared by: repair the stored JSON or retire row ${row.id} with orch record outbox retire`,
  )
}

function latestSyncedRows(database: Database): SyncedOutboxRow[] {
  return database
    .query<SyncedOutboxRow, []>(
      `SELECT current.id,current.kind,current.record_id,current.payload
         FROM outbox current
         JOIN (
           SELECT kind,record_id,max(id) AS id
             FROM outbox INDEXED BY outbox_latest_synced_record
            WHERE synced_at IS NOT NULL
            GROUP BY kind,record_id
         ) latest
           ON latest.id=current.id
          AND latest.kind=current.kind
          AND latest.record_id=current.record_id
        ORDER BY current.kind,current.record_id`,
    )
    .all()
}

function remainsEligible(database: Database, row: SyncedOutboxRow): boolean {
  return Boolean(
    database
      .query<{ id: number }, [string, string, number]>(
        `SELECT id FROM outbox candidate
          WHERE kind=? AND record_id=? AND id=? AND synced_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM outbox newer
               WHERE newer.kind=candidate.kind
                 AND newer.record_id=candidate.record_id
                 AND newer.id>candidate.id
                 AND (newer.synced_at IS NOT NULL OR newer.retired_at IS NULL)
            )`,
      )
      .get(row.kind, row.record_id, row.id),
  )
}

function countRecordRules(
  counts: Map<string, SyncedRedactionCount>,
  kind: string,
  rules: readonly string[],
): void {
  for (const rule of rules) {
    const key = `${kind}\0${rule}`
    const count = counts.get(key)
    if (count) count.count += 1
    else counts.set(key, { kind, rule, count: 1 })
  }
}

export function redactSyncedOutbox(
  options: { rules: ReadonlySet<string>; dryRun: boolean },
  database: Database = writableDb(),
  at = nowIso(),
  actorSession = sessionId(),
): SyncedRedactionResult {
  const counts = new Map<string, SyncedRedactionCount>()
  const skipped: SyncedRedactionSkip[] = []
  let enqueued = 0
  let wouldEnqueue = 0
  for (const row of latestSyncedRows(database)) {
    const sanitized = sanitizeOutboxPayloadForRules(row.kind, parsePayload(row), options.rules)
    if (sanitized.matches.length === 0) continue
    const recordRules = [...new Set(sanitized.matches.map((match) => match.rule))].toSorted()
    countRecordRules(counts, row.kind, recordRules)
    if (options.dryRun) {
      if (!remainsEligible(database, row)) {
        skipped.push({ kind: row.kind, recordId: row.record_id })
        continue
      }
      wouldEnqueue += 1
      continue
    }
    const inserted = writeTransaction(() => {
      if (!remainsEligible(database, row)) return false
      const inserted = database
        .query<{ id: number }, [string, string, string, string]>(
          `INSERT INTO outbox (kind,record_id,payload,created_at)
           VALUES (?,?,?,?) RETURNING id`,
        )
        .get(row.kind, row.record_id, JSON.stringify(sanitized.payload), at)!
      const paths = [...new Set(sanitized.matches.map((match) => match.path))].toSorted()
      database
        .query(
          `INSERT INTO outbox_redaction_audit
           (outbox_id,kind,record_id,rules,withheld_paths,actor_session,at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          inserted.id,
          row.kind,
          row.record_id,
          JSON.stringify(recordRules),
          JSON.stringify(paths),
          actorSession,
          at,
        )
      return true
    }, database)
    if (!inserted) {
      skipped.push({ kind: row.kind, recordId: row.record_id })
      continue
    }
    wouldEnqueue += 1
    enqueued += 1
  }
  return {
    counts: [...counts.values()].toSorted(
      (left, right) => left.kind.localeCompare(right.kind) || left.rule.localeCompare(right.rule),
    ),
    enqueued,
    wouldEnqueue,
    skipped,
    dryRun: options.dryRun,
  }
}

export function renderSyncedRedaction(result: SyncedRedactionResult): string {
  const lines = result.counts.map((row) => `${row.kind}\t${row.rule}\t${row.count}`)
  for (const row of result.skipped) lines.push(`skipped\t${row.kind}\t${row.recordId}`)
  lines.push(
    result.dryRun
      ? `enqueued\t0\tdry run; would enqueue ${result.wouldEnqueue}`
      : `enqueued\t${result.enqueued}`,
  )
  return lines.join('\n')
}
