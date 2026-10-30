// concern: monitor-notices
/** Owns monitor notice currentness, claiming, formatting, and delivery acknowledgement. */

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  BOARD_READ_REFRESH_BUDGET_MS,
  refreshHostedBoard,
  takeHostedBoardVerificationTransition,
} from '../board/board-hosted-cache.ts'
import {
  deliveryWarning,
  markBoardDeliveryDelivered,
  pendingBoardDelivery,
} from '../board/board-push-service.ts'
import { requireRealSession } from '../board/board-service.ts'
import { db, nowIso, openReadOnlyDatabase, writableDb, writeTransaction } from '../database/db.ts'
import type { MonitorSeverity } from '../review/review-vocabulary.ts'
import {
  abandonedBootstrapConditions,
  askingRuns,
  deadRunningProcessConditions,
  idleRunConditions,
  rulingConditions,
  stalledRunConditions,
  terminalCloseOutRuns,
  unscoredRuns,
} from './monitor-conditions.ts'
import { checkHostedPressureCached } from './monitor-hosted-pressure.ts'
import {
  MONITOR_NOTICE_DELIVERY_POLICY,
  type MonitorNotice,
  type MonitorNoticeKind,
} from './monitor-types.ts'

function deliveredDetail(row: {
  subject: string
  age_ms: number | null
  run_status: string | null
  run_project: string | null
}): string {
  const age = row.age_ms == null ? 'age unknown' : `age ${Math.round(row.age_ms / 60_000)}m`
  const status = row.run_status ? `, status ${row.run_status}` : ''
  const project = row.run_project ? `, project ${row.run_project}` : ''
  const target = row.subject.startsWith('run:') ? 'run' : 'referenced record'
  return `detected (${age}${status}${project}); inspect the ${target} deliberately.`
}

/** A notice names a run by its local number; any other subject, or an unresolved run, by its subject. */
function noticeLabel(subject: string, runNumber: number | null = null): string {
  return subject.startsWith('run:') && runNumber !== null ? `run ${runNumber}` : subject
}

function landingNoticeDetail(row: {
  record_id: string
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
  return `${event} ${row.record_id}/${branch} ${duration}; inspect with '${PLATFORM_SLUG} tree branch'`
}

function recordStalledRunSubjects(
  kinds: Set<string>,
  record: (kind: string, subjects: string[]) => void,
  database: Database,
): void {
  if (!kinds.has('stalled-run')) return
  record(
    'stalled-run',
    stalledRunConditions(Date.now(), {}, database).map((condition) => condition.subject),
  )
}

function recordAbandonedBootstrapSubjects(
  kinds: Set<string>,
  record: (kind: string, subjects: string[]) => void,
  database: Database,
): void {
  if (!kinds.has('abandoned-bootstrap')) return
  record(
    'abandoned-bootstrap',
    abandonedBootstrapConditions(Date.now(), database).map((condition) => condition.subject),
  )
}

function recordIdleDetectorSubjects(
  kinds: Set<string>,
  record: (kind: string, subjects: string[]) => void,
  database: Database,
): void {
  if (!kinds.has('idle') && !kinds.has('stuck-host-wait')) return
  const detected = idleRunConditions(Date.now(), database)
  if (kinds.has('idle')) {
    record(
      'idle',
      detected
        .filter((condition) => condition.kind === 'idle')
        .map((condition) => condition.subject),
    )
  }
  if (kinds.has('stuck-host-wait')) {
    record(
      'stuck-host-wait',
      detected
        .filter((condition) => condition.kind === 'stuck-host-wait')
        .map((condition) => condition.subject),
    )
  }
}

function currentAddressedSubjects(
  kinds: Set<string>,
  database: Database,
): Map<string, Set<string>> {
  for (const kind of kinds) {
    if (!(kind in MONITOR_NOTICE_DELIVERY_POLICY)) {
      throw new Error(`monitor notice kind ${kind} has no delivery-currentness policy`)
    }
  }

  const current = new Map<string, Set<string>>()
  const record = (kind: string, subjects: string[]) => current.set(kind, new Set(subjects))
  recordAbandonedBootstrapSubjects(kinds, record, database)
  if (kinds.has('asking-run')) {
    record(
      'asking-run',
      askingRuns(database).map((run) => `run:${run.record_id}`),
    )
  }
  if (kinds.has('dead-running-process')) {
    record(
      'dead-running-process',
      deadRunningProcessConditions(Date.now(), database).map((condition) => condition.subject),
    )
  }
  recordIdleDetectorSubjects(kinds, record, database)
  recordStalledRunSubjects(kinds, record, database)
  if (kinds.has('task-waiting-on-ruling')) {
    record(
      'task-waiting-on-ruling',
      rulingConditions().conditions.map((condition) => condition.subject),
    )
  }
  if (kinds.has('terminal-close-out-held') || kinds.has('terminal-close-out-failed')) {
    const closeOuts = terminalCloseOutRuns(database)
    for (const outcome of ['held', 'failed'] as const) {
      const kind = `terminal-close-out-${outcome}`
      if (kinds.has(kind)) {
        record(
          kind,
          closeOuts
            .filter((run) => run.close_out_outcome === outcome)
            .map((run) => `run:${run.record_id}`),
        )
      }
    }
  }
  if (kinds.has('unscored-run')) {
    record(
      'unscored-run',
      unscoredRuns(database).map((run) => `run:${run.record_id}`),
    )
  }
  return current
}

/** Read addressed findings without consuming them. A failed consumer gets them again. */
export function claimMonitorNotices(
  ownerSession: string,
  database: Database = db(),
): MonitorNotice[] {
  requireRealSession(ownerSession, 'monitor notices')
  const rows = database
    .query(
      `SELECT c.number, c.kind, c.subject, c.condition_since, c.age_ms,
              c.issue_key, c.severity, c.owner_session_id,
              r.number run_number, r.status run_status, r.repo run_project
         FROM monitor_condition c
         JOIN monitor_invocation invocation ON invocation.record_id=c.invocation_record_id
         LEFT JOIN run r ON c.subject=('run:' || r.record_id)
        WHERE c.owner_session_id=? AND c.delivered_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM monitor_condition newest
            JOIN monitor_invocation newest_invocation
              ON newest_invocation.record_id=newest.invocation_record_id
             WHERE newest.kind=c.kind AND newest.subject=c.subject
               AND newest.condition_since IS c.condition_since
               AND newest.owner_session_id=c.owner_session_id
               AND (newest_invocation.started_at>invocation.started_at OR
                    (newest_invocation.started_at=invocation.started_at AND
                     newest.record_id>c.record_id))
          )
        ORDER BY invocation.started_at,c.record_id`,
    )
    .all(ownerSession) as {
    number: number
    kind: string
    subject: string
    condition_since: string | null
    age_ms: number | null
    issue_key: string | null
    severity: MonitorSeverity | null
    owner_session_id: string
    run_number: number | null
    run_status: string | null
    run_project: string | null
  }[]
  const kinds = new Set(rows.map((row) => row.kind))
  const current = currentAddressedSubjects(kinds, database)
  const conditions = rows
    .filter(
      (row) =>
        MONITOR_NOTICE_DELIVERY_POLICY[row.kind as MonitorNoticeKind] === 'append-only' ||
        current.get(row.kind)?.has(row.subject),
    )
    .map((row) => ({
      noticeId: `condition:${row.number}` as const,
      kind: row.kind,
      subject: row.subject,
      label: noticeLabel(row.subject, row.run_number),
      since: row.condition_since,
      ageMs: row.age_ms,
      detail: deliveredDetail(row),
      issueKey: row.issue_key,
      severity: row.severity,
      ownerSession: row.owner_session_id,
    }))
  const landings = database
    .query(
      `SELECT record_id, branch, status, started_at, finished_at, session_id
       FROM landing
      WHERE session_id=? AND heartbeat_delivered_at IS NULL
        AND status IN ('refused','rebase_required','install_failed')
      ORDER BY record_id`,
    )
    .all(ownerSession) as {
    record_id: string
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
        noticeId: `landing:${row.record_id}`,
        kind: `landing-${row.status.replaceAll('_', '-')}`,
        subject: `landing:${row.record_id}`,
        label: noticeLabel(`landing:${row.record_id}`),
        since: row.finished_at ?? row.started_at,
        ageMs: null,
        detail: landingNoticeDetail(row),
        ownerSession: row.session_id,
      }),
    ),
  ]
}

type HostedVerificationSource = { source: 'stored' } | { source: 'refresh'; warning: string | null }

async function claimMonitorNoticesWithHosted(
  ownerSession: string,
  verificationSource: HostedVerificationSource,
): Promise<{ notices: MonitorNotice[]; warning: string | null }> {
  const database = openReadOnlyDatabase()
  try {
    const board = await pendingBoardDelivery({
      session: ownerSession,
      budgetMs: 0,
      database,
      claimReplySuccessors: false,
    })
    const verification = verificationSource.source === 'refresh' ? verificationSource.warning : null
    const overflow = board.delivery.length ? board.overflow : null
    return {
      notices: [
        ...claimMonitorNotices(ownerSession, database),
        ...board.delivery.map(
          (notice): MonitorNotice => ({
            noticeId: `board:${notice.id}`,
            kind: 'board-notice',
            subject: `board:${notice.id}`,
            label: noticeLabel(`board:${notice.id}`),
            since: null,
            ageMs: null,
            detail: notice.text,
            ownerSession,
          }),
        ),
      ],
      warning: deliveryWarning(overflow, board.warning, verification),
    }
  } finally {
    database.close()
  }
}

/** Refresh when requested, then claim notices through a separate read-only store handle. */
export async function claimMonitorNoticesForCommand(
  ownerSession: string,
  input: { skipBoardRefresh: boolean },
): Promise<{ notices: MonitorNotice[]; warning: string | null }> {
  try {
    await checkHostedPressureCached({ failFastStoreClaim: true })
  } catch {
    // Notice delivery is independent of an unavailable machine-local detector.
  }
  let verificationSource: HostedVerificationSource = { source: 'stored' }
  if (!input.skipBoardRefresh) {
    await refreshHostedBoard({ budgetMs: BOARD_READ_REFRESH_BUDGET_MS })
    verificationSource = {
      source: 'refresh',
      warning: takeHostedBoardVerificationTransition(),
    }
  }
  return claimMonitorNoticesWithHosted(ownerSession, verificationSource)
}

/**
 * The one definition of the notice-id grammar.
 *
 * A notice id is `<source>:<identifier>`: `condition` takes a positive integer,
 * `landing` a version-7 UUID, and `board` any non-empty identifier. Every other
 * reader of a notice id -- the heartbeat hook and the session brief -- passes ids
 * through and reports the names this rule refuses, because a second copy of the
 * rule is a copy that drifts.
 */
function parseNoticeId(
  token: string,
): { source: 'condition' | 'landing' | 'board'; id: string } | { refusal: string } {
  const match = /^(condition|landing|board):(.+)$/.exec(token)
  if (!match)
    return {
      refusal: 'a notice id is <source>:<identifier> with source condition, landing or board',
    }
  const source = match[1] as 'condition' | 'landing' | 'board'
  const id = match[2]!
  if (source === 'condition' && !/^[1-9]\d*$/.test(id))
    return { refusal: 'a condition id is a positive integer' }
  if (
    source === 'landing' &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    return { refusal: 'a landing id is a version-7 UUID' }
  return { source, id }
}

/** A refused id is named in output, where a control character or a long name would forge a line. */
function refusedNoticeName(token: string): string {
  const name = Array.from(String(token), (character) =>
    character < ' ' || character === String.fromCharCode(127) ? ' ' : character,
  ).join('')
  return name === '' ? '(empty notice id)' : name.slice(0, 80)
}

export type MonitorNoticeAcknowledgement = {
  acknowledged: MonitorNotice['noticeId'][]
  refused: { id: string; reason: string }[]
  /** Board identifiers exactly as parseNoticeId read them; no caller re-derives them. */
  boardIds: string[]
}

/**
 * Acknowledge only the rows the hook has already emitted to its consumer.
 *
 * One id the grammar refuses is contained: it is named in the result for the
 * caller to report, and every valid id in the same batch is still acknowledged.
 */
export function markMonitorNoticesDelivered(
  ownerSession: string,
  ids: MonitorNotice['noticeId'][],
  deliveredAt = nowIso(),
): MonitorNoticeAcknowledgement {
  requireRealSession(ownerSession, 'monitor notice acknowledgement')
  const parsed: {
    source: 'condition' | 'landing' | 'board'
    id: string
    token: MonitorNotice['noticeId']
  }[] = []
  const refused: { id: string; reason: string }[] = []
  for (const token of ids) {
    const parsedId = parseNoticeId(token)
    if ('refusal' in parsedId) {
      refused.push({ id: refusedNoticeName(token), reason: parsedId.refusal })
      continue
    }
    parsed.push({ ...parsedId, token })
  }
  const database = writableDb()
  writeTransaction(() => {
    const mark = database.query(
      `UPDATE monitor_condition SET delivered_at=? WHERE number=? AND owner_session_id=? AND delivered_at IS NULL`,
    )
    const conditions = new Set(
      parsed.filter(({ source }) => source === 'condition').map(({ id }) => Number(id)),
    )
    const landings = new Set(
      parsed.filter(({ source }) => source === 'landing').map(({ id }) => id),
    )
    // A receipt may stamp a landing only when that source-qualified landing token
    // came from the claim that produced the emission. Equal ids in other sources do not qualify.
    for (const id of conditions) mark.run(deliveredAt, id, ownerSession)
    const markLanding = database.query(
      `UPDATE landing SET heartbeat_delivered_at=?
        WHERE record_id=? AND session_id=? AND heartbeat_delivered_at IS NULL
          AND status IN ('refused','rebase_required','install_failed')`,
    )
    for (const id of landings) markLanding.run(deliveredAt, id, ownerSession)
  }, database)
  return {
    acknowledged: parsed.map(({ token }) => token),
    refused,
    boardIds: parsed.filter(({ source }) => source === 'board').map(({ id }) => id),
  }
}

export async function markMonitorNoticesDeliveredWithHosted(
  ownerSession: string,
  ids: MonitorNotice['noticeId'][],
  deliveredAt = nowIso(),
): Promise<MonitorNoticeAcknowledgement> {
  const acknowledgement = markMonitorNoticesDelivered(ownerSession, ids, deliveredAt)
  // Only an acknowledged board id reaches the hosted receipt; a refused one is
  // named in the result instead of being asked for as if it were a board id.
  const board = acknowledgement.boardIds
  if (board.length)
    await markBoardDeliveryDelivered({
      session: ownerSession,
      ids: board,
      clock: Date.parse(deliveredAt),
      deliveryPoint: 'heartbeat-monitor',
      emissionId: randomUUID(),
    })
  return acknowledgement
}
