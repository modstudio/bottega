// concern: operator-waiting
/** Owns durable operator-waiting state, relay policy, and its stable read model. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { type OperatorInboxKind, operatorInboxPath } from '../../../shared/operator-inbox.ts'
import {
  type OperatorNotification,
  sendOperatorNotification,
} from '../../../shared/operator-notification.ts'
import type {
  ClaimedOperatorNotification,
  OperatorWaitingItem,
} from '../../../shared/orch-contract.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from '../run/run-authority.ts'
import { resolveAnswerRulings } from '../workflow/autonomy-scopes.ts'

type WaitingCause = { rulings: 'agent' | 'user'; relayed: boolean; answered: boolean }
export const questionAwaitingOperator = (cause: WaitingCause): boolean =>
  !cause.answered && (cause.rulings === 'user' || cause.relayed)

export async function initialQuestionWaitingAt(
  runId: string,
  at: string,
  d: Database = db(),
): Promise<string | null> {
  const row = d
    .query('SELECT repo, launch_key, task_record_id FROM run WHERE record_id=?')
    .get(runId) as {
    repo: string | null
    launch_key: string | null
    task_record_id: string | null
  } | null
  if (!row?.repo) return null
  const rulings = await resolveAnswerRulings(row.repo, {
    taskRecordId: row.task_record_id,
    database: d,
  })
  return questionAwaitingOperator({ rulings: rulings.value, relayed: false, answered: false })
    ? at
    : null
}

const firstLine = (value: string) => value.split(/\r?\n/, 1)[0]!

function notificationDetails(item: OperatorWaitingItem): OperatorNotification {
  const port = readMachineValue('hub.port')
  const subject = [item.project, item.task_key].filter(Boolean).join(' ')
  return {
    title: `Ruling needed${subject ? `: ${subject}` : ''}`,
    body: firstLine(item.question),
    link: `http://127.0.0.1:${port}${operatorInboxPath(item.kind, item.id)}`,
  }
}

/** Atomically claim each currently waiting episode once, optionally narrowed for direct delivery. */
export function claimOperatorNotifications(
  d: Database = db(),
  only?: { kind: OperatorInboxKind; id: string | number },
): ClaimedOperatorNotification[] {
  return writeTransaction(() => {
    const items = operatorWaitingWithEpisodes(d).filter(({ item }) => {
      if (!only || item.kind !== only.kind) return !only
      return item.kind === 'question'
        ? item.question_record_id === only.id
        : String(item.id) === String(only.id)
    })
    const claimed: ClaimedOperatorNotification[] = []
    const insert = d.query(
      `INSERT OR IGNORE INTO operator_notification
       (record_id,kind,item_id,question_record_id,episode,notified_at) VALUES (?,?,?,?,?,?)`,
    )
    for (const { item, episode } of items) {
      if (
        insert.run(
          newRecordId(),
          item.kind,
          item.kind === 'workflow' ? item.id : null,
          item.kind === 'question' ? item.question_record_id : null,
          episode,
          nowIso(),
        ).changes !== 1
      )
        continue
      claimed.push({ ...item, notification: notificationDetails(item) })
    }
    return claimed
  }, d)
}

/** Claim and send from trusted in-process paths; delivery failure cannot fail the mutation. */
export function notifyWaitingItem(
  kind: OperatorInboxKind,
  id: string | number,
  d: Database,
  send: typeof sendOperatorNotification = sendOperatorNotification,
): void {
  try {
    for (const item of claimOperatorNotifications(d, { kind, id })) send(item.notification)
  } catch (error) {
    console.error(`orch: desktop notification failed: ${String(error)}`)
  }
}

function openQuestions(runId: string, d: Database) {
  const authority = authorizeRunMutation(runId, 'relay')
  const rows = d
    .query(
      `SELECT q.record_id,q.number,q.answered_at,q.closed_at FROM question q JOIN run owner ON owner.record_id=q.run_record_id
       WHERE (owner.record_id=? OR owner.parent_run_record_id=?) ORDER BY q.number`,
    )
    .all(authority.rootId, authority.rootId) as {
    record_id: string
    number: number
    answered_at: string | null
    closed_at: string | null
  }[]
  return { authority, rows }
}

export function relayQuestion(
  runId: string,
  questionId: string | undefined,
  note: string,
  d: Database = db(),
  notify: (kind: OperatorInboxKind, id: string | number, d: Database) => void = notifyWaitingItem,
): { id: number; recordId: string } {
  let { authority, rows } = openQuestions(runId, d)
  if (questionId !== undefined) {
    const named = rows.find((row) => row.record_id === questionId)
    if (!named) throw new Error(`question ${questionId} does not belong to run ${authority.rootId}`)
    if (named.answered_at) throw new Error(`question ${questionId} is already answered`)
    if (named.closed_at) throw new Error(`question ${questionId} is already closed`)
    rows = [named]
  } else {
    rows = rows.filter((row) => !row.answered_at && !row.closed_at)
    if (!rows.length) throw new Error(`run ${authority.rootId} has no open question`)
    if (rows.length > 1)
      throw new Error(
        `run ${authority.rootId} has ${rows.length} open questions; select one question`,
      )
  }
  const selected = rows[0]!
  writeTransaction(() => {
    authority = adoptRunMutation(authority, 'relay', d)
    const at = nowIso()
    const changed = d
      .query(
        `UPDATE question SET awaiting_operator_at=COALESCE(awaiting_operator_at,?), relayed_by=?,
          revision=revision+1
         WHERE record_id=? AND ${questionOpenSql('question')}`,
      )
      .run(at, authority.actor, selected.record_id)
    if (changed.changes !== 1) throw new Error(`question ${selected.number} is already answered`)
    auditRunMutation(authority, 'relay', note, d)
    enqueueQuestionRecord(d, selected.record_id)
  }, d)
  notify('question', selected.record_id, d)
  return { id: selected.number, recordId: selected.record_id }
}

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

type WorkflowWaitingRow = {
  id: number
  workflow_cursor_record_id: string
  question_record_id: string
  project: string
  task_key: string | null
  question: string
  waiting_since: string
  workflow_slug: string
  mode_slug: string
  args: string
  session_id: string | null
}

function workflowWaitingEpisode(row: WorkflowWaitingRow) {
  const flags = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`)
    .join('')
  return {
    episode: row.waiting_since,
    item: {
      kind: 'workflow' as const,
      id: row.id,
      workflow_cursor_record_id: row.workflow_cursor_record_id,
      question_record_id: row.question_record_id,
      run_number: null,
      run_record_id: null,
      project: row.project,
      task_key: row.task_key,
      session_id: row.session_id,
      question: row.question,
      options: [],
      recommendation: null,
      why: null,
      waiting_since: row.waiting_since,
      episode: row.waiting_since,
      answer_command: `${PLATFORM_SLUG} workflow rule ${shellWord(row.workflow_slug)} --project ${shellWord(row.project)} --mode ${shellWord(row.mode_slug)}${flags} --ruling "<ruling>" --from-operator`,
    },
  }
}

function operatorWaitingWithEpisodes(
  d: Database,
): Array<{ item: OperatorWaitingItem; episode: string }> {
  const questions = d
    .query(
      `SELECT q.number,q.record_id question_record_id,q.question,q.options,q.recommendation,q.why,q.awaiting_operator_at,
              r.repo project,r.launch_key task_key,root.number root_number,
              root.record_id root_record_id
       FROM question q JOIN run r ON r.record_id=q.run_record_id
       JOIN run root ON root.record_id=COALESCE(r.parent_run_record_id,r.record_id)
       WHERE q.awaiting_operator_at IS NOT NULL AND ${questionOpenSql('q')}`,
    )
    .all() as Array<{
    number: number
    question_record_id: string
    question: string
    options: string | null
    recommendation: string | null
    why: string | null
    awaiting_operator_at: string
    project: string | null
    task_key: string | null
    root_number: number
    root_record_id: string
  }>
  const workflows = d
    .query(
      `SELECT c.number id,c.record_id workflow_cursor_record_id,c.project,q.record_id question_record_id,q.workflow_key task_key,q.question,q.asked_at waiting_since,
              c.workflow_slug,c.mode_slug,c.args,c.session_id
         FROM workflow_cursor c JOIN question q ON q.workflow_cursor_record_id=c.record_id
        WHERE c.state='awaiting-ruling' AND ${questionOpenSql('q')}`,
    )
    .all() as WorkflowWaitingRow[]
  return [
    ...questions.map((row) => ({
      episode: row.awaiting_operator_at,
      item: {
        kind: 'question' as const,
        id: row.number,
        workflow_cursor_record_id: null,
        question_record_id: row.question_record_id,
        run_number: row.root_number,
        run_record_id: row.root_record_id,
        project: row.project,
        task_key: row.task_key,
        session_id: null,
        question: row.question,
        options: row.options ? JSON.parse(row.options) : [],
        recommendation: row.recommendation,
        why: row.why,
        waiting_since: row.awaiting_operator_at,
        episode: row.awaiting_operator_at,
        answer_command: `${PLATFORM_SLUG} question answer ${row.root_number} --q${row.number} --from-operator "<ruling>"`,
      },
    })),
    ...workflows.map(workflowWaitingEpisode),
  ].sort(
    (a, b) =>
      a.item.waiting_since.localeCompare(b.item.waiting_since) ||
      a.item.kind.localeCompare(b.item.kind) ||
      a.item.id - b.item.id,
  )
}

export function operatorWaiting(d: Database = db()): OperatorWaitingItem[] {
  return operatorWaitingWithEpisodes(d).map(({ item }) => item)
}
