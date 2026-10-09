import type { Database } from 'bun:sqlite'
import type { OrchRun, RulingListRow } from '../../../shared/orch-contract.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { attributeRun, refreshKeyPrefixes } from '../attribute.ts'
import { nowIso, writeTransaction } from '../db.ts'
import { readRuns, readWorkflowRulings } from '../orch.ts'
import { decideCollectorReplace, type ExistingIntervalRow } from './interval-replace.ts'

export type { OrchRun } from '../../../shared/orch-contract.ts'

/**
 * Delegated agent runs, as intervals.
 *
 * Read through `orch runs --json` rather than by opening orch.db. The
 * orchestrator owns that file; a second concern reading it directly is how the
 * "a database per concern" line stops being true, and the CLI is a published
 * interface that can keep working when the schema behind it moves.
 */
function rootRef(id: number) {
  return `orch:${id}`
}

function runRef(rootId: number, questionRunId: number, hasTurns: boolean) {
  return hasTurns ? `orch:${rootId}:turn:${questionRunId}` : `orch:${rootId}`
}

function deliveryRunRef(run: OrchRun, receivingRunId: number | null): string | null {
  if (receivingRunId == null) return null
  const belongsToChain =
    receivingRunId === run.id || run.turns?.some((turn) => turn.id === receivingRunId)
  return belongsToChain && run.turns
    ? `orch:${run.id}:turn:${receivingRunId}`
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
    const root = rootRef(run.id)
    const hasTurns = Boolean(run.turns)
    deleteRootQuestions.run(root)
    for (const question of run.questions) {
      upsertQuestion.run(
        question.id,
        runRef(run.id, question.run_id, hasTurns),
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
          deliveryRunRef(run, delivery.run_id),
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
      (question_id,run_ref,root_ref,workflow_cursor_id,workflow_key,project,task_key,
       session_id,asked_at,answered_at,asked_via,answerer_kind,answer_channel,
       overturned_at,closed_at,close_reason)
     VALUES (?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(question_id) DO UPDATE SET
       workflow_cursor_id=excluded.workflow_cursor_id,
       workflow_key=excluded.workflow_key,
       project=excluded.project,
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
      ref: run.turns ? `orch:${run.id}:turn:${turn.id}` : `orch:${run.id}`,
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
) {
  const decision = decideCollectorReplace(existing, recomputed)
  const update = conn.query(
    `UPDATE interval SET end_at=?, vendor_tokens=?, vendor_cost_usd=?, task_key=?,
       project=?, job=?, via=?, open=?, session_id=?, user_id=?
     WHERE record_id=?`,
  )
  const insert = conn.query(
    `INSERT INTO interval (record_id, task_key, project, source, agent, job, start_at, end_at,
                           claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id)
     VALUES (?, ?, ?, 'orch', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const remove = conn.query(`DELETE FROM interval WHERE record_id=?`)
  for (const row of decision.updates)
    update.run(
      row.end_at,
      row.vendor_tokens,
      row.vendor_cost_usd,
      row.task_key,
      row.project,
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
    closeReplaced(retryOf: number) {
      closeReplaced.run(`orch:${retryOf}`, `orch:%:turn:${retryOf}`)
    },
    close(ref: string) {
      close.run(ref)
    },
    replaceChain(rootId: number, rows: readonly OrchIntervalRow[]) {
      applyOrchReplace(conn, selectChain.all(`orch:${rootId}`, `orch:${rootId}:turn:%`), rows)
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
    let skipped = 0
    for (const turn of turns) {
      const built = orchIntervalRow(run, turn, attribution, now)
      if (built.status === 'skip') {
        skipped++
        continue
      }
      recomputed.push(built.value)
    }
    writer.replaceChain(run.id, recomputed)
    return { rows: recomputed.length, skipped }
  }
  const built = orchIntervalRow(run, turns[0]!, attribution, now)
  if (built.status === 'skip') {
    if (built.close) writer.close(`orch:${run.id}`)
    return { rows: 0, skipped: 1 }
  }
  writer.replaceRef(`orch:${run.id}`, [built.value])
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
  for (const run of runs) {
    const attribution = attributeRun(run)
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
    if (run.retry_of != null) writer.closeReplaced(run.retry_of)
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
  const now = Date.now()
  return writeTransaction((conn) => ingestRunRows(conn, runs, workflowQuestions, now, snapshot))
}
