// concern: monitor-notices
/** Owns monitor notice currentness, claiming, formatting, and delivery acknowledgement. */

import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import type { MonitorSeverity } from '../review/review-vocabulary.ts'
import {
  askingRuns,
  deadRunningProcessConditions,
  idleRunConditions,
  rulingConditions,
  stalledRunConditions,
  terminalCloseOutRuns,
  unscoredRuns,
} from './monitor-conditions.ts'
import type { MonitorNotice } from './monitor-types.ts'

const APPEND_ONLY_DELIVERY_KINDS = new Set([
  'ghost-open-interval',
  'observation-error',
  'stale-run',
])

const REVALIDATED_DELIVERY_KINDS = new Set([
  'asking-run',
  'dead-running-process',
  'idle',
  'stalled-run',
  'task-waiting-on-ruling',
  'terminal-close-out-held',
  'terminal-close-out-failed',
  'unscored-run',
])

function deliveredDetail(row: {
  kind: string
  subject: string
  age_ms: number | null
  run_status: string | null
  run_project: string | null
}): string {
  const age = row.age_ms == null ? 'age unknown' : `age ${Math.round(row.age_ms / 60_000)}m`
  const status = row.run_status ? `, status ${row.run_status}` : ''
  const project = row.run_project ? `, project ${row.run_project}` : ''
  return `Orch detected ${row.kind} for ${row.subject} (${age}${status}${project}); inspect the referenced record deliberately.`
}

function landingNoticeDetail(row: {
  id: number
  branch: string
  status: string
  started_at: string
  finished_at: string | null
}): string {
  const started = Date.parse(row.started_at)
  const finished = row.finished_at === null ? started : Date.parse(row.finished_at)
  const elapsed =
    Number.isFinite(started) && Number.isFinite(finished)
      ? Math.max(0, Math.round((finished - started) / 1000))
      : null
  const duration =
    elapsed === null
      ? '?'
      : elapsed >= 60
        ? `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s`
        : `${elapsed.toFixed(1)}s`
  const event =
    row.status === 'refused'
      ? 'LANDING-REFUSED'
      : row.status === 'rebase_required'
        ? 'LANDING-REBASE-REQUIRED'
        : 'LANDING-INSTALL-FAILED'
  const branch = row.branch.replace(/[\t\r\n]/g, ' ')
  return `${event} ${row.id}/${branch} ${duration}; inspect with 'orch branches'`
}

function currentAddressedSubjects(kinds: Set<string>): Map<string, Set<string>> {
  for (const kind of kinds) {
    if (!APPEND_ONLY_DELIVERY_KINDS.has(kind) && !REVALIDATED_DELIVERY_KINDS.has(kind)) {
      throw new Error(`monitor notice kind ${kind} has no delivery-currentness policy`)
    }
  }

  const current = new Map<string, Set<string>>()
  const record = (kind: string, subjects: string[]) => current.set(kind, new Set(subjects))
  if (kinds.has('asking-run')) {
    record(
      'asking-run',
      askingRuns().map((run) => `run:${run.id}`),
    )
  }
  if (kinds.has('dead-running-process')) {
    record(
      'dead-running-process',
      deadRunningProcessConditions().map((condition) => condition.subject),
    )
  }
  if (kinds.has('idle')) {
    record(
      'idle',
      idleRunConditions().map((condition) => condition.subject),
    )
  }
  if (kinds.has('stalled-run')) {
    record(
      'stalled-run',
      stalledRunConditions().map((condition) => condition.subject),
    )
  }
  if (kinds.has('task-waiting-on-ruling')) {
    record(
      'task-waiting-on-ruling',
      rulingConditions().conditions.map((condition) => condition.subject),
    )
  }
  if (kinds.has('terminal-close-out-held') || kinds.has('terminal-close-out-failed')) {
    const closeOuts = terminalCloseOutRuns()
    for (const outcome of ['held', 'failed'] as const) {
      const kind = `terminal-close-out-${outcome}`
      if (kinds.has(kind)) {
        record(
          kind,
          closeOuts
            .filter((run) => run.close_out_outcome === outcome)
            .map((run) => `run:${run.id}`),
        )
      }
    }
  }
  if (kinds.has('unscored-run')) {
    record(
      'unscored-run',
      unscoredRuns().map((run) => `run:${run.id}`),
    )
  }
  return current
}

/** Read addressed findings without consuming them. A failed consumer gets them again. */
export function claimMonitorNotices(ownerSession: string): MonitorNotice[] {
  if (!ownerSession.trim()) throw new Error('monitor notices require a session id')
  const rows = db()
    .query(
      `SELECT c.id, c.kind, c.subject, c.condition_since, c.age_ms,
              c.issue_key, c.severity, c.owner_session_id,
              r.status run_status, r.repo run_project
         FROM monitor_condition c
         LEFT JOIN run r ON c.subject=('run:' || r.id)
        WHERE c.owner_session_id=? AND c.delivered_at IS NULL
          AND c.id = (
            SELECT MAX(newest.id) FROM monitor_condition newest
             WHERE newest.kind=c.kind AND newest.subject=c.subject
               AND newest.condition_since IS c.condition_since
               AND newest.owner_session_id=c.owner_session_id
          )
        ORDER BY c.id`,
    )
    .all(ownerSession) as {
    id: number
    kind: string
    subject: string
    condition_since: string | null
    age_ms: number | null
    issue_key: string | null
    severity: MonitorSeverity | null
    owner_session_id: string
    run_status: string | null
    run_project: string | null
  }[]
  const kinds = new Set(rows.map((row) => row.kind))
  const current = currentAddressedSubjects(kinds)
  const conditions = rows
    .filter(
      (row) => APPEND_ONLY_DELIVERY_KINDS.has(row.kind) || current.get(row.kind)?.has(row.subject),
    )
    .map((row) => ({
      noticeId: `condition:${row.id}` as const,
      kind: row.kind,
      subject: row.subject,
      since: row.condition_since,
      ageMs: row.age_ms,
      detail: deliveredDetail(row),
      issueKey: row.issue_key,
      severity: row.severity,
      ownerSession: row.owner_session_id,
    }))
  const landings = db()
    .query(
      `SELECT id, branch, status, started_at, finished_at, session_id
       FROM landing
      WHERE session_id=? AND heartbeat_delivered_at IS NULL
        AND status IN ('refused','rebase_required','install_failed')
      ORDER BY id`,
    )
    .all(ownerSession) as {
    id: number
    branch: string
    status: string
    started_at: string
    finished_at: string | null
    session_id: string
  }[]
  return [
    ...conditions,
    ...landings.map(
      (row): MonitorNotice => ({
        noticeId: `landing:${row.id}`,
        kind: `landing-${row.status.replaceAll('_', '-')}`,
        subject: `landing:${row.id}`,
        since: row.finished_at ?? row.started_at,
        ageMs: null,
        detail: landingNoticeDetail(row),
        ownerSession: row.session_id,
      }),
    ),
  ]
}

/** Acknowledge only rows the hook has already emitted to its consumer. */
export function markMonitorNoticesDelivered(
  ownerSession: string,
  ids: MonitorNotice['noticeId'][],
  deliveredAt = nowIso(),
): void {
  if (!ownerSession.trim()) throw new Error('monitor notice acknowledgement requires a session id')
  const parsed = ids.map((token) => {
    const match = /^(condition|landing):([1-9]\d*)$/.exec(token)
    if (!match)
      throw new Error('monitor notice acknowledgement requires source-qualified notice ids')
    return { source: match[1] as 'condition' | 'landing', id: Number(match[2]) }
  })
  if (!parsed.length || parsed.some(({ id }) => !Number.isSafeInteger(id))) {
    throw new Error('monitor notice acknowledgement requires source-qualified notice ids')
  }
  const database = writableDb()
  writeTransaction(() => {
    const mark = database.query(
      `UPDATE monitor_condition SET delivered_at=? WHERE id=? AND owner_session_id=? AND delivered_at IS NULL`,
    )
    const conditions = new Set(
      parsed.filter(({ source }) => source === 'condition').map(({ id }) => id),
    )
    const landings = new Set(
      parsed.filter(({ source }) => source === 'landing').map(({ id }) => id),
    )
    // A receipt may stamp a landing only when that source-qualified landing token
    // came from the claim that produced the emission. Equal ids in other sources do not qualify.
    for (const id of conditions) mark.run(deliveredAt, id, ownerSession)
    const markLanding = database.query(
      `UPDATE landing SET heartbeat_delivered_at=?
        WHERE id=? AND session_id=? AND heartbeat_delivered_at IS NULL
          AND status IN ('refused','rebase_required','install_failed')`,
    )
    for (const id of landings) markLanding.run(deliveredAt, id, ownerSession)
  }, database)
}
