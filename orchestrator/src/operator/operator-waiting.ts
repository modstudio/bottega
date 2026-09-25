// concern: operator-waiting
/** Owns durable operator-waiting state, relay policy, and its stable read model. */

import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from '../run/run-authority.ts'
import { resolveAnswerRulings } from '../workflow/autonomy-scopes.ts'
import { sendOperatorNotification } from './operator-notification.ts'

type WaitingCause = { rulings: 'agent' | 'user'; relayed: boolean; answered: boolean }
export const questionAwaitingOperator = (cause: WaitingCause): boolean =>
  !cause.answered && (cause.rulings === 'user' || cause.relayed)

export async function initialQuestionWaitingAt(
  runId: number,
  at: string,
  d: Database = db(),
): Promise<string | null> {
  const row = d.query('SELECT repo, launch_key FROM run WHERE id=?').get(runId) as {
    repo: string | null
    launch_key: string | null
  } | null
  if (!row?.repo) return null
  const rulings = await resolveAnswerRulings(row.repo, row.launch_key, undefined, d)
  return questionAwaitingOperator({ rulings: rulings.value, relayed: false, answered: false })
    ? at
    : null
}

const firstLine = (value: string) => value.split(/\r?\n/, 1)[0]!

function notificationDetails(kind: 'question' | 'workflow', id: number, d: Database) {
  const row =
    kind === 'question'
      ? (d
          .query(
            `SELECT q.question, r.repo project, r.launch_key task_key
             FROM question q JOIN run r ON r.id=q.run_id WHERE q.id=?`,
          )
          .get(id) as { question: string; project: string | null; task_key: string | null } | null)
      : (d
          .query(
            `SELECT question, project, NULLIF(workflow_key,'') task_key
             FROM workflow_cursor WHERE id=?`,
          )
          .get(id) as { question: string; project: string; task_key: string | null } | null)
  if (!row?.question || !row.project) return null
  return {
    title: `Ruling needed: ${row.project}${row.task_key ? ` ${row.task_key}` : ''}`,
    body: firstLine(row.question),
    link: `http://127.0.0.1:7778/inbox/${kind}/${id}`,
  }
}

export function notifyWaitingQuestion(
  id: number,
  d: Database = db(),
  send: typeof sendOperatorNotification = sendOperatorNotification,
): void {
  const at = nowIso()
  const changed = d
    .query(
      `UPDATE question SET notified_at=?
       WHERE id=? AND awaiting_operator_at IS NOT NULL AND answered_at IS NULL AND notified_at IS NULL`,
    )
    .run(at, id)
  if (changed.changes !== 1) return
  const details = notificationDetails('question', id, d)
  if (details) send(details)
}

export function markWorkflowNotification(id: number, d: Database): boolean {
  const inserted = d
    .query(
      `INSERT OR IGNORE INTO workflow_operator_notification (cursor_id,notified_at) VALUES (?,?)`,
    )
    .run(id, nowIso())
  return inserted.changes === 1
}

export function notifyWaitingWorkflow(id: number, d: Database = db()): void {
  const details = notificationDetails('workflow', id, d)
  if (details) sendOperatorNotification(details)
}

function openQuestions(runId: number, d: Database) {
  const authority = authorizeRunMutation(runId, 'relay')
  const rows = d
    .query(
      `SELECT q.id, q.answered_at FROM question q JOIN run owner ON owner.id=q.run_id
       WHERE (owner.id=? OR owner.parent_run_id=?) ORDER BY q.id`,
    )
    .all(authority.rootId, authority.rootId) as { id: number; answered_at: string | null }[]
  return { authority, rows }
}

export function relayQuestion(
  runId: number,
  questionId: number | undefined,
  note: string,
  d: Database = db(),
  notify: (id: number, d: Database) => void = notifyWaitingQuestion,
): number {
  if (!note.trim()) throw new Error('--note is required')
  let { authority, rows } = openQuestions(runId, d)
  if (questionId !== undefined) {
    const named = rows.find((row) => row.id === questionId)
    if (!named) throw new Error(`question ${questionId} does not belong to run ${authority.rootId}`)
    if (named.answered_at) throw new Error(`question ${questionId} is already answered`)
    rows = [named]
  } else {
    rows = rows.filter((row) => !row.answered_at)
    if (!rows.length) throw new Error(`run ${authority.rootId} has no open question`)
    if (rows.length > 1)
      throw new Error(`run ${authority.rootId} has ${rows.length} open questions; pass --q<id>`)
  }
  const id = rows[0]!.id
  writeTransaction(() => {
    authority = adoptRunMutation(authority, 'relay', d)
    const at = nowIso()
    const changed = d
      .query(
        `UPDATE question SET awaiting_operator_at=COALESCE(awaiting_operator_at,?), relayed_by=?
         WHERE id=? AND answered_at IS NULL`,
      )
      .run(at, authority.actor, id)
    if (changed.changes !== 1) throw new Error(`question ${id} is already answered`)
    auditRunMutation(authority, 'relay', note.trim(), d)
  }, d)
  notify(id, d)
  return id
}

/** Stable JSON contract consumed by hub: field names and nullability are part of the interface. */
export type OperatorWaitingItem = {
  kind: 'question' | 'workflow'
  id: number
  project: string
  task_key: string | null
  question: string
  options: string[]
  recommendation: string | null
  why: string | null
  waiting_since: string
  answer_command: string
}

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

export function operatorWaiting(d: Database = db()): OperatorWaitingItem[] {
  const questions = d
    .query(
      `SELECT q.id,q.question,q.options,q.recommendation,q.why,q.awaiting_operator_at,
              r.repo project,r.launch_key task_key,COALESCE(r.parent_run_id,r.id) root_id
       FROM question q JOIN run r ON r.id=q.run_id
       WHERE q.awaiting_operator_at IS NOT NULL AND q.answered_at IS NULL`,
    )
    .all() as Array<{
    id: number
    question: string
    options: string | null
    recommendation: string | null
    why: string | null
    awaiting_operator_at: string
    project: string
    task_key: string | null
    root_id: number
  }>
  const workflows = d
    .query(
      `SELECT id,project,NULLIF(workflow_key,'') task_key,question,updated_at,workflow_slug,
              mode_slug,args FROM workflow_cursor WHERE state='awaiting-ruling'`,
    )
    .all() as Array<{
    id: number
    project: string
    task_key: string | null
    question: string
    updated_at: string
    workflow_slug: string
    mode_slug: string
    args: string
  }>
  return [
    ...questions.map(
      (row): OperatorWaitingItem => ({
        kind: 'question',
        id: row.id,
        project: row.project,
        task_key: row.task_key,
        question: row.question,
        options: row.options ? JSON.parse(row.options) : [],
        recommendation: row.recommendation,
        why: row.why,
        waiting_since: row.awaiting_operator_at,
        answer_command: `orch answer ${row.root_id} --q${row.id} --from-operator "<ruling>"`,
      }),
    ),
    ...workflows.map((row): OperatorWaitingItem => {
      const args = JSON.parse(row.args) as Record<string, string>
      const flags = Object.entries(args)
        .map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`)
        .join('')
      return {
        kind: 'workflow',
        id: row.id,
        project: row.project,
        task_key: row.task_key,
        question: row.question,
        options: [],
        recommendation: null,
        why: null,
        waiting_since: row.updated_at,
        answer_command: `orch workflow next ${shellWord(row.workflow_slug)} --project ${shellWord(row.project)} --mode ${shellWord(row.mode_slug)}${flags} --note "<ruling>"`,
      }
    }),
  ].sort(
    (a, b) =>
      a.waiting_since.localeCompare(b.waiting_since) || a.kind.localeCompare(b.kind) || a.id - b.id,
  )
}
