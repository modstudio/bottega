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
import { mutateQuestion } from '../question-store/question-store-mutation.ts'
import {
  inboxRunQuestions,
  questionsForRun,
  waitingQuestions,
} from '../question-store/question-store-read.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from '../run/run-authority.ts'
import { resolveAnswerRulings } from '../workflow/autonomy-scopes.ts'
import type { TaskFlowWaitingQuestionRow as WorkflowWaitingRow } from '../workflow/task-flow-store.ts'

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
export async function claimOperatorNotifications(
  d: Database = db(),
  only?: { kind: OperatorInboxKind; id: string | number },
): Promise<ClaimedOperatorNotification[]> {
  const [workflows, runQuestions] = await Promise.all([waitingQuestions(d), inboxRunQuestions(d)])
  return writeTransaction(() => {
    const items = operatorWaitingWithEpisodes(workflows, runQuestions).filter(({ item }) => {
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
export async function notifyWaitingItem(
  kind: OperatorInboxKind,
  id: string | number,
  d: Database,
  send: typeof sendOperatorNotification = sendOperatorNotification,
): Promise<void> {
  try {
    for (const item of await claimOperatorNotifications(d, { kind, id })) send(item.notification)
  } catch (error) {
    console.error(`orch: desktop notification failed: ${String(error)}`)
  }
}

async function openQuestions(runId: string, d: Database) {
  const authority = authorizeRunMutation(runId, 'relay')
  const runIds = d
    .query<{ record_id: string }, [string, string]>(
      'SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY number',
    )
    .all(authority.rootId, authority.rootId)
    .map(({ record_id }) => record_id)
  const rows = (await Promise.all(runIds.map((id) => questionsForRun(d, id)))).flat() as {
    record_id: string
    number: number
    answered_at: string | null
    closed_at: string | null
    awaiting_operator_at: string | null
  }[]
  return { authority, rows }
}

export async function relayQuestion(
  runId: string,
  questionId: string | undefined,
  note: string,
  d: Database = db(),
  notify: (
    kind: OperatorInboxKind,
    id: string | number,
    d: Database,
  ) => void | Promise<void> = notifyWaitingItem,
): Promise<{ id: number; recordId: string }> {
  let { authority, rows } = await openQuestions(runId, d)
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
  }, d)
  const at = nowIso()
  const mutation = await mutateQuestion(d, {
    id: selected.record_id,
    intent: 'relay',
    at,
    actorSession: authority.actor,
    reason: note,
    requireOpen: true,
    changes: {
      awaitingOperatorAt: selected.awaiting_operator_at ?? at,
      relayedBy: authority.actor,
    },
  })
  if (!mutation.applied) return { id: selected.number, recordId: selected.record_id }
  writeTransaction(() => {
    auditRunMutation(authority, 'relay', note, d)
  }, d)
  await notify('question', selected.record_id, d)
  return { id: selected.number, recordId: selected.record_id }
}

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

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
  workflows: WorkflowWaitingRow[],
  questions: Record<string, unknown>[],
): Array<{ item: OperatorWaitingItem; episode: string }> {
  const waiting = questions.filter((row) => row.awaiting_operator_at && !row.answered_at) as Array<{
    number: number
    record_id: string
    question: string
    options: string | null
    recommendation: string | null
    why: string | null
    awaiting_operator_at: string
    repo: string | null
    task_key: string | null
    root_number: number
    root_record_id: string
  }>
  return [
    ...waiting.map((row) => ({
      episode: row.awaiting_operator_at,
      item: {
        kind: 'question' as const,
        id: row.number,
        workflow_cursor_record_id: null,
        question_record_id: row.record_id,
        run_number: row.root_number,
        run_record_id: row.root_record_id,
        project: row.repo,
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

export async function operatorWaiting(d: Database = db()): Promise<OperatorWaitingItem[]> {
  const [workflows, runQuestions] = await Promise.all([waitingQuestions(d), inboxRunQuestions(d)])
  return operatorWaitingWithEpisodes(workflows, runQuestions).map(({ item }) => item)
}
