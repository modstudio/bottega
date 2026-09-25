// concern: operator-waiting
/** Owns durable operator-waiting state, relay policy, and its stable read model. */

import type { Database } from 'bun:sqlite'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { type OperatorInboxKind, operatorInboxPath } from '../../../shared/operator-inbox.ts'
import { sendOperatorNotification } from '../../../shared/operator-notification.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from '../run/run-authority.ts'
import { resolveAnswerRulings } from '../workflow/autonomy-scopes.ts'

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

type OperatorNotificationDetails = {
  title: string
  body: string
  link: string
}

function notificationDetails(item: OperatorWaitingItem): OperatorNotificationDetails {
  const port = readMachineValue('hub.port')
  return {
    title: `Ruling needed: ${item.project}${item.task_key ? ` ${item.task_key}` : ''}`,
    body: firstLine(item.question),
    link: `http://127.0.0.1:${port}${operatorInboxPath(item.kind, item.id)}`,
  }
}

export type ClaimedOperatorNotification = OperatorWaitingItem & {
  notification: OperatorNotificationDetails
}

/** Atomically claim each currently waiting episode once, optionally narrowed for direct delivery. */
export function claimOperatorNotifications(
  d: Database = db(),
  only?: { kind: OperatorInboxKind; id: number },
): ClaimedOperatorNotification[] {
  return writeTransaction(() => {
    const items = operatorWaitingWithEpisodes(d).filter(
      ({ item }) => !only || (item.kind === only.kind && item.id === only.id),
    )
    const claimed: ClaimedOperatorNotification[] = []
    const insert = d.query(
      `INSERT OR IGNORE INTO operator_notification (kind,item_id,episode,notified_at)
       VALUES (?,?,?,?)`,
    )
    for (const { item, episode } of items) {
      if (insert.run(item.kind, item.id, episode, nowIso()).changes !== 1) continue
      claimed.push({ ...item, notification: notificationDetails(item) })
    }
    return claimed
  }, d)
}

/** Claim and send from trusted in-process paths; delivery failure cannot fail the mutation. */
export function notifyWaitingItem(
  kind: OperatorInboxKind,
  id: number,
  d: Database,
  send: typeof sendOperatorNotification = sendOperatorNotification,
): void {
  try {
    for (const item of claimOperatorNotifications(d, { kind, id })) send(item.notification)
  } catch (error) {
    console.error(`orch: desktop notification failed: ${String(error)}`)
  }
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
  notify: (kind: OperatorInboxKind, id: number, d: Database) => void = notifyWaitingItem,
): number {
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
      throw new Error(
        `run ${authority.rootId} has ${rows.length} open questions; select one question`,
      )
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
    auditRunMutation(authority, 'relay', note, d)
  }, d)
  notify('question', id, d)
  return id
}

/** Stable JSON contract consumed by hub: field names and nullability are part of the interface. */
export type OperatorWaitingItem = {
  kind: 'question' | 'workflow'
  id: number
  run_id: number | null
  project: string
  task_key: string | null
  session_id: string | null
  question: string
  options: string[]
  recommendation: string | null
  why: string | null
  waiting_since: string
  answer_command: string
}

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

function operatorWaitingWithEpisodes(
  d: Database,
): Array<{ item: OperatorWaitingItem; episode: string }> {
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
              mode_slug,args,session_id FROM workflow_cursor WHERE state='awaiting-ruling'`,
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
    session_id: string | null
  }>
  return [
    ...questions.map((row) => ({
      episode: row.awaiting_operator_at,
      item: {
        kind: 'question' as const,
        id: row.id,
        run_id: row.root_id,
        project: row.project,
        task_key: row.task_key,
        session_id: null,
        question: row.question,
        options: row.options ? JSON.parse(row.options) : [],
        recommendation: row.recommendation,
        why: row.why,
        waiting_since: row.awaiting_operator_at,
        answer_command: `orch answer ${row.root_id} --q${row.id} --from-operator "<ruling>"`,
      },
    })),
    ...workflows.map((row) => {
      const args = JSON.parse(row.args) as Record<string, string>
      const flags = Object.entries(args)
        .map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`)
        .join('')
      return {
        episode: row.updated_at,
        item: {
          kind: 'workflow' as const,
          id: row.id,
          run_id: null,
          project: row.project,
          task_key: row.task_key,
          session_id: row.session_id,
          question: row.question,
          options: [],
          recommendation: null,
          why: null,
          waiting_since: row.updated_at,
          answer_command: `orch workflow next ${shellWord(row.workflow_slug)} --project ${shellWord(row.project)} --mode ${shellWord(row.mode_slug)}${flags} --note "<ruling>"`,
        },
      }
    }),
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
