import type { Database } from 'bun:sqlite'
import type { OrchRun, RulingListRow, RunIdentity } from '../../../shared/orch-contract.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { attributeRun, refreshKeyPrefixes } from '../attribute.ts'
import { db, nowIso, writeTransaction } from '../db.ts'
import { intervalOwningProject } from '../interval-project-correction.ts'
import { readRunIdentityMap, readRuns, readWorkflowRulings } from '../orch.ts'
import { projectRecordIdFor } from '../project-record-id.ts'
import { projects } from '../projects.ts'
import { decideCollectorReplace, type ExistingIntervalRow } from './interval-replace.ts'

export type { OrchRun } from '../../../shared/orch-contract.ts'

/**
 * Delegated agent runs, as intervals.
 *
 * Read through `bottega run list --json` rather than by opening orch.db. The
 * orchestrator owns that file; a second concern reading it directly is how the
 * "a database per concern" line stops being true, and the CLI is a published
 * interface that can keep working when the schema behind it moves.
 */
function rootRef(id: string) {
  return `orch:${id}`
}

function runRef(rootId: string, questionRunId: string, hasTurns: boolean) {
  return hasTurns ? `orch:${rootId}:turn:${questionRunId}` : `orch:${rootId}`
}

type RunRefConversionReport = { interval: number; question: number; question_delivery: number }
type RefRow = { row_id: number; value: string }

function legacyRunRef(value: string): { root: string; turn: string | null } | null {
  const match = /^orch:([1-9]\d*)(?::turn:([1-9]\d*))?$/.exec(value)
  return match ? { root: match[1]!, turn: match[2] ?? null } : null
}

function convertReferenceRows(
  table: 'question' | 'question_delivery',
  column: string,
  rows: RefRow[],
  convert: (value: string) => string | null,
  update: (target: string, rowId: number) => void,
  report: RunRefConversionReport,
  missing: string[],
): void {
  for (const row of rows.filter((candidate) => legacyRunRef(candidate.value))) {
    const target = convert(row.value)
    if (!target) {
      missing.push(`${table}.${column} ${row.row_id}: ${row.value}`)
      continue
    }
    if (target !== row.value) {
      update(target, row.row_id)
      report[table]++
    }
  }
}

function convertIntervalRefs(
  conn: Database,
  convert: (value: string) => string | null,
  report: RunRefConversionReport,
  missing: string[],
): void {
  const rows = conn
    .query<{ record_id: string; ref: string }, []>(
      "SELECT record_id,ref FROM interval WHERE ref LIKE 'orch:%'",
    )
    .all()
    .filter((row) => legacyRunRef(row.ref))
  const update = conn.query('UPDATE interval SET ref=? WHERE record_id=?')
  for (const row of rows) {
    const target = convert(row.ref)
    if (!target) {
      missing.push(`interval ${row.record_id}: ${row.ref}`)
      continue
    }
    if (target === row.ref) continue
    const collision = conn
      .query<{ record_id: string }, [string, string]>(
        'SELECT record_id FROM interval WHERE ref=? AND record_id<>? LIMIT 1',
      )
      .get(target, row.record_id)
    if (collision)
      throw new Error(
        `refusing numeric run-ref conversion: interval ${row.record_id} maps to ${target}, already held by ${collision.record_id}`,
      )
    update.run(target, row.record_id)
    report.interval++
  }
}

/** Convert the three durable Hub columns that mirror orchestrator run identity. */
export function convertLegacyRunRefs(
  conn: Database,
  identities: readonly RunIdentity[],
): RunRefConversionReport {
  const identityByNumber = new Map(identities.map((run) => [String(run.id), run.record_id]))
  const convert = (value: string): string | null => {
    const parsed = legacyRunRef(value)
    if (!parsed) return value
    const root = identityByNumber.get(parsed.root)
    const turn = parsed.turn ? identityByNumber.get(parsed.turn) : null
    if (!root || (parsed.turn && !turn)) return null
    return parsed.turn ? `orch:${root}:turn:${turn}` : `orch:${root}`
  }
  const report: RunRefConversionReport = { interval: 0, question: 0, question_delivery: 0 }
  const missing: string[] = []
  convertIntervalRefs(conn, convert, report, missing)
  convertReferenceRows(
    'question',
    'run_ref',
    conn
      .query<{ row_id: number; value: string }, []>(
        "SELECT question_id row_id,run_ref value FROM question WHERE run_ref LIKE 'orch:%'",
      )
      .all(),
    convert,
    (target, rowId) =>
      conn.query('UPDATE question SET run_ref=? WHERE question_id=?').run(target, rowId),
    report,
    missing,
  )
  convertReferenceRows(
    'question',
    'root_ref',
    conn
      .query<{ row_id: number; value: string }, []>(
        "SELECT question_id row_id,root_ref value FROM question WHERE root_ref LIKE 'orch:%'",
      )
      .all(),
    convert,
    (target, rowId) =>
      conn.query('UPDATE question SET root_ref=? WHERE question_id=?').run(target, rowId),
    report,
    missing,
  )
  convertReferenceRows(
    'question_delivery',
    'run_ref',
    conn
      .query<{ row_id: number; value: string }, []>(
        "SELECT rowid row_id,run_ref value FROM question_delivery WHERE run_ref LIKE 'orch:%'",
      )
      .all(),
    convert,
    (target, rowId) =>
      conn.query('UPDATE question_delivery SET run_ref=? WHERE rowid=?').run(target, rowId),
    report,
    missing,
  )
  if (missing.length)
    throw new Error(`numeric run refs have no orchestrator UUID mapping:\n${missing.join('\n')}`)
  return report
}

function hasLegacyRunRefs(conn: Database): boolean {
  const rows = [
    ...conn
      .query<{ value: string }, []>("SELECT ref value FROM interval WHERE ref LIKE 'orch:%'")
      .all(),
    ...conn
      .query<{ value: string }, []>(
        "SELECT run_ref value FROM question WHERE run_ref LIKE 'orch:%'",
      )
      .all(),
    ...conn
      .query<{ value: string }, []>(
        "SELECT root_ref value FROM question WHERE root_ref LIKE 'orch:%'",
      )
      .all(),
    ...conn
      .query<{ value: string }, []>(
        "SELECT run_ref value FROM question_delivery WHERE run_ref LIKE 'orch:%'",
      )
      .all(),
  ]
  return rows.some((row) => legacyRunRef(row.value))
}

function deliveryRunRef(run: OrchRun, receivingRunId: string | null): string | null {
  if (receivingRunId == null) return null
  const belongsToChain =
    receivingRunId === run.record_id || run.turns?.some((turn) => turn.record_id === receivingRunId)
  return belongsToChain && run.turns
    ? `orch:${run.record_id}:turn:${receivingRunId}`
    : `orch:${receivingRunId}`
}

function questionReplacer(conn: Database) {
  const upsertQuestion = conn.query(
    `INSERT INTO question
      (question_id, run_ref, root_ref, task_key, session_id, asked_at, answered_at,
       asked_via, answerer_kind, answer_channel, overturned_at, closed_at, close_reason)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(question_id) DO UPDATE SET
     run_ref        = excluded.run_ref,
     root_ref       = excluded.root_ref,
     task_key       = excluded.task_key,
     session_id     = excluded.session_id,
     asked_at       = excluded.asked_at,
     answered_at    = excluded.answered_at,
     asked_via      = excluded.asked_via,
     answerer_kind  = excluded.answerer_kind,
     answer_channel = excluded.answer_channel,
     overturned_at  = excluded.overturned_at,
     closed_at      = excluded.closed_at,
     close_reason   = excluded.close_reason`,
  )
  const deleteQuestionDeliveries = conn.query(`DELETE FROM question_delivery WHERE question_id = ?`)
  const insertQuestionDelivery = conn.query(
    `INSERT INTO question_delivery (question_id, run_ref, mode, outcome, at, error)
     VALUES (?,?,?,?,?,?)`,
  )
  const deleteRootQuestions = conn.query(`DELETE FROM question WHERE root_ref = ?`)

  return (run: OrchRun, taskKey: string | null) => {
    const root = rootRef(run.record_id)
    const hasTurns = Boolean(run.turns)
    deleteRootQuestions.run(root)
    for (const question of run.questions) {
      upsertQuestion.run(
        question.id,
        runRef(run.record_id, question.run_record_id, hasTurns),
        root,
        taskKey,
        run.session_id,
        question.asked_at,
        question.answered_at,
        question.asked_via,
        question.answerer_kind,
        question.answer_channel,
        question.overturned_at,
        question.closed_at,
        question.close_reason,
      )
      deleteQuestionDeliveries.run(question.id)
      for (const delivery of question.deliveries) {
        insertQuestionDelivery.run(
          question.id,
          deliveryRunRef(run, delivery.run_record_id),
          delivery.mode,
          delivery.outcome,
          delivery.at,
          delivery.error,
        )
      }
    }
  }
}

function upsertWorkflowQuestions(conn: Database, questions: readonly RulingListRow[]): void {
  const upsert = conn.query(
    `INSERT INTO question
      (question_id,run_ref,root_ref,workflow_cursor_id,workflow_key,project,project_record_id,task_key,
       session_id,asked_at,answered_at,asked_via,answerer_kind,answer_channel,
       overturned_at,closed_at,close_reason)
     VALUES (?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(question_id) DO UPDATE SET
       workflow_cursor_id=excluded.workflow_cursor_id,
       workflow_key=excluded.workflow_key,
       project=excluded.project,
       project_record_id=COALESCE(excluded.project_record_id,question.project_record_id),
       task_key=excluded.task_key,
       session_id=excluded.session_id,
       asked_at=excluded.asked_at,
       answered_at=excluded.answered_at,
       asked_via=excluded.asked_via,
       answerer_kind=excluded.answerer_kind,
       answer_channel=excluded.answer_channel,
       overturned_at=excluded.overturned_at,
       closed_at=excluded.closed_at,
       close_reason=excluded.close_reason`,
  )
  for (const question of questions) {
    upsert.run(
      question.id,
      question.workflow_cursor_id,
      question.workflow_key,
      question.project,
      projectRecordIdFor(question.project),
      question.workflow_key,
      question.session_id,
      question.asked_at,
      question.answered_at,
      question.asked_via,
      question.answerer_kind,
      question.answer_channel,
      question.overturned_at,
      question.closed_at,
      question.close_reason,
    )
  }
}

export function executionSpans(r: OrchRun, now = Date.now()) {
  return (r.turns ?? [r]).flatMap((turn) => {
    const start = new Date(turn.started_at).getTime()
    if (!Number.isFinite(start)) return []
    if (turn.latency_ms == null && turn.status !== 'running') return []
    const end = turn.latency_ms == null ? Math.max(now, start) : start + turn.latency_ms
    return [{ start, end }]
  })
}

export function chainVendorTokens(r: OrchRun): number | null {
  const turns = r.turns ?? [r]
  let total: number | null = null
  for (const turn of turns) {
    if (turn.vendor_tokens != null) total = (total ?? 0) + turn.vendor_tokens
  }
  return total
}

type OrchAttribution = { key: string | null; project: string | null; via: string | null }

type OrchIntervalRow = {
  source: 'orch'
  ref: string
  start_at: string
  end_at: string
  task_key: string | null
  project: string | null
  agent: string | null
  job: string | null
  vendor_tokens: number
  vendor_cost_usd: number | null
  via: string | null
  open: number
  session_id: string | null
  user_id: string | null
}

type OrchTurnLike = {
  id: number
  record_id: string
  started_at: string
  latency_ms: number | null
  status: string
  vendor_tokens: number | null
  vendor_cost_usd: number | null
}

function orchIntervalRow(
  run: OrchRun,
  turn: OrchTurnLike,
  attribution: OrchAttribution,
  now: number,
): { status: 'skip'; close: boolean } | { status: 'row'; value: OrchIntervalRow } {
  const start = new Date(turn.started_at).getTime()
  if (!Number.isFinite(start)) return { status: 'skip', close: false }
  if (turn.latency_ms == null && turn.status !== 'running')
    return { status: 'skip', close: !run.turns }
  const end = turn.latency_ms == null ? Math.max(now, start) : start + turn.latency_ms
  return {
    status: 'row',
    value: {
      source: 'orch',
      ref: run.turns ? `orch:${run.record_id}:turn:${turn.record_id}` : `orch:${run.record_id}`,
      start_at: new Date(start).toISOString(),
      end_at: new Date(end).toISOString(),
      task_key: attribution.key,
      project: attribution.project,
      agent: run.agent,
      job: run.job,
      vendor_tokens: turn.vendor_tokens ?? 0,
      vendor_cost_usd: turn.vendor_cost_usd,
      via: attribution.via,
      open: turn.latency_ms == null ? 1 : 0,
      session_id: run.session_id,
      user_id: run.started_by_user_id ?? null,
    },
  }
}

function applyOrchReplace(
  conn: Database,
  existing: ExistingIntervalRow[],
  recomputed: readonly OrchIntervalRow[],
  preservedRefs: ReadonlySet<string> = new Set(),
) {
  const decision = decideCollectorReplace(existing, recomputed, preservedRefs)
  const update = conn.query(
    `UPDATE interval SET end_at=?, vendor_tokens=?, vendor_cost_usd=?, task_key=?,
       project=?, project_record_id=?, job=?, via=?, open=?, session_id=?, user_id=?
     WHERE record_id=?`,
  )
  const insert = conn.query(
    `INSERT INTO interval (record_id, task_key, project, project_record_id, source, agent, job, start_at, end_at,
                           claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id)
     VALUES (?, ?, ?, ?, 'orch', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const remove = conn.query(`DELETE FROM interval WHERE record_id=?`)
  for (const row of decision.updates)
    update.run(
      row.end_at,
      row.vendor_tokens,
      row.vendor_cost_usd,
      row.task_key,
      row.project,
      projectRecordIdFor(row.project),
      row.job,
      row.via,
      row.open,
      row.session_id,
      row.user_id,
      row.record_id,
    )
  for (const row of decision.inserts)
    insert.run(
      newRecordId(),
      row.task_key,
      row.project,
      projectRecordIdFor(row.project),
      row.agent,
      row.job,
      row.start_at,
      row.end_at,
      row.vendor_tokens,
      row.vendor_cost_usd,
      row.ref,
      row.via,
      row.open,
      row.session_id,
      row.user_id,
    )
  for (const recordId of decision.deletes) remove.run(recordId)
}

function orchIntervalWriter(conn: Database) {
  const selectChain = conn.query<ExistingIntervalRow, [string, string]>(
    `SELECT record_id, source, ref, start_at FROM interval
     WHERE source = 'orch' AND (ref = ? OR ref LIKE ?)`,
  )
  const selectRef = conn.query<ExistingIntervalRow, [string]>(
    `SELECT record_id, source, ref, start_at FROM interval WHERE source = 'orch' AND ref = ?`,
  )
  const close = conn.query(`UPDATE interval SET open = 0 WHERE source = 'orch' AND ref = ?`)
  const closeReplaced = conn.query(
    `UPDATE interval SET open = 0
     WHERE source = 'orch' AND open = 1 AND (ref = ? OR ref LIKE ?)`,
  )
  return {
    closeReplaced(retryOf: string) {
      closeReplaced.run(`orch:${retryOf}`, `orch:%:turn:${retryOf}`)
    },
    close(ref: string) {
      close.run(ref)
    },
    replaceChain(
      rootId: string,
      rows: readonly OrchIntervalRow[],
      preservedRefs: ReadonlySet<string>,
    ) {
      applyOrchReplace(
        conn,
        selectChain.all(`orch:${rootId}`, `orch:${rootId}:turn:%`),
        rows,
        preservedRefs,
      )
    },
    replaceRef(ref: string, rows: readonly OrchIntervalRow[]) {
      applyOrchReplace(conn, selectRef.all(ref), rows)
    },
  }
}

function ingestOneRun(
  run: OrchRun,
  attribution: OrchAttribution,
  writer: ReturnType<typeof orchIntervalWriter>,
  now: number,
): { rows: number; skipped: number } {
  const turns = run.turns ?? [run]
  if (run.turns) {
    const recomputed: OrchIntervalRow[] = []
    const preservedRefs = new Set<string>()
    let skipped = 0
    for (const turn of turns) {
      const built = orchIntervalRow(run, turn, attribution, now)
      if (built.status === 'skip') {
        preservedRefs.add(`orch:${run.record_id}:turn:${turn.record_id}`)
        skipped++
        continue
      }
      recomputed.push(built.value)
    }
    writer.replaceChain(run.record_id, recomputed, preservedRefs)
    return { rows: recomputed.length, skipped }
  }
  const built = orchIntervalRow(run, turns[0]!, attribution, now)
  if (built.status === 'skip') {
    if (built.close) writer.close(`orch:${run.record_id}`)
    return { rows: 0, skipped: 1 }
  }
  writer.replaceRef(`orch:${run.record_id}`, [built.value])
  return { rows: 1, skipped: 0 }
}

function ingestRunRows(
  conn: Database,
  runs: readonly OrchRun[],
  workflowQuestions: readonly RulingListRow[],
  now: number,
  snapshot: string,
): { rows: number; skipped: number } {
  const writer = orchIntervalWriter(conn)
  const replaceQuestions = questionReplacer(conn)
  upsertWorkflowQuestions(conn, workflowQuestions)
  let rows = 0
  let skipped = 0
  const registered = projects()
  for (const run of runs) {
    const attributed = attributeRun(run)
    const attribution = {
      ...attributed,
      project: intervalOwningProject(attributed.project, attributed.key, registered),
    }
    replaceQuestions(run, attribution.key)
    // A probe is a smoke test — "reply with ok" — that did no work on
    // anything, so it is not engaged time on any task. A question on it is
    // still a request for a ruling.
    if (run.probe === 1) {
      skipped++
      continue
    }
    // Failover is a new root, not another turn of the run it replaces. The
    // predecessor can therefore fall outside this collect's time window even
    // while its successor is present. Close the predecessor from the handoff
    // itself; waiting to see that old row again leaves its last open sample
    // growing forever. retry_of may name either a root or a resumed child.
    const retryRecordId = (run as OrchRun & { retry_record_id?: string | null }).retry_record_id
    if (retryRecordId) writer.closeReplaced(retryRecordId)
    const result = ingestOneRun(run, attribution, writer, now)
    rows += result.rows
    skipped += result.skipped
  }
  conn
    .query(`INSERT INTO setting (key, value) VALUES ('collect.runs.at', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(snapshot))
  return { rows, skipped }
}

export async function ingestRuns(since: string): Promise<{ rows: number; skipped: number }> {
  refreshKeyPrefixes()
  // Snapshot time, not completion: anything that happens during the read is
  // re-fetched next time. Overlap is cheap; a missed answer is not.
  const snapshot = nowIso()
  const [runs, workflowQuestions] = await Promise.all([readRuns(since), readWorkflowRulings(since)])
  const legacyRefs = hasLegacyRunRefs(db())
  const identities = legacyRefs ? await readRunIdentityMap() : []
  const now = Date.now()
  return writeTransaction((conn) => {
    if (legacyRefs) convertLegacyRunRefs(conn, identities)
    return ingestRunRows(conn, runs, workflowQuestions, now, snapshot)
  })
}
