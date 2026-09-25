// concern: operator-waiting-email-local
/** Selects overdue operator waits and pushes each episode to the hosted mail service once. */

import { readMachineValue } from '../../shared/machine-config.ts'
import { operatorInboxPath } from '../../shared/operator-inbox.ts'
import type { OperatorWaitingItem } from '../../shared/orch-contract.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { waiting } from './orch.ts'
import { signedInRecordUserId } from './sync.ts'
import { hostedCreateOperatorWaitingEmail } from './task-client.ts'

const DEFAULT_OPERATOR_EMAIL_DELAY_MINUTES = 30
const OPERATOR_EMAIL_DELAY_SETTING = 'operator_email_delay_minutes'

export type WaitingEmailLedgerKey = Pick<OperatorWaitingItem, 'kind' | 'id' | 'episode'>

const ledgerKey = (item: WaitingEmailLedgerKey) =>
  `${item.kind}\u0000${item.id}\u0000${item.episode}`

/** Question text reaches the caller only after this pure decision says the episode is due. */
export function dueOperatorWaitingEmails(
  items: readonly OperatorWaitingItem[],
  now: Date,
  delayMinutes: number,
  pushed: readonly WaitingEmailLedgerKey[],
): OperatorWaitingItem[] {
  if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) return []
  const cutoff = now.getTime() - delayMinutes * 60_000
  const known = new Set(pushed.map(ledgerKey))
  return items.filter((item) => {
    const since = Date.parse(item.waiting_since)
    return Number.isFinite(since) && since < cutoff && !known.has(ledgerKey(item))
  })
}

export function operatorEmailDelayMinutes(): number {
  const row = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(OPERATOR_EMAIL_DELAY_SETTING)
  if (!row) return DEFAULT_OPERATOR_EMAIL_DELAY_MINUTES
  const value = Number(JSON.parse(row.value))
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_OPERATOR_EMAIL_DELAY_MINUTES
}

export function setOperatorEmailDelayMinutes(value: number): void {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(OPERATOR_EMAIL_DELAY_SETTING, JSON.stringify(value)),
  )
}

function pushedEpisodes(): WaitingEmailLedgerKey[] {
  return db()
    .query<{ kind: 'question' | 'workflow'; item_id: number; episode: string }, []>(
      'SELECT kind,item_id,episode FROM operator_waiting_email ORDER BY kind,item_id,episode',
    )
    .all()
    .map((row) => ({ kind: row.kind, id: row.item_id, episode: row.episode }))
}

function recordPushed(item: OperatorWaitingItem): void {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT OR IGNORE INTO operator_waiting_email(kind,item_id,episode,pushed_at)
         VALUES (?,?,?,?)`,
      )
      .run(item.kind, item.id, item.episode, nowIso()),
  )
}

export async function deliverOperatorWaitingEmails(
  dependencies: {
    readWaiting?: typeof waiting
    signedIn?: typeof signedInRecordUserId
    push?: typeof hostedCreateOperatorWaitingEmail
    now?: () => Date
    delay?: () => number
    ledger?: () => WaitingEmailLedgerKey[]
    record?: (item: OperatorWaitingItem) => void
    error?: (message: string) => void
  } = {},
): Promise<void> {
  const error = dependencies.error ?? console.error
  let due: OperatorWaitingItem[]
  try {
    const delay = (dependencies.delay ?? operatorEmailDelayMinutes)()
    if (delay <= 0) return
    if (!(await (dependencies.signedIn ?? signedInRecordUserId)())) return
    const items = await (dependencies.readWaiting ?? waiting)()
    due = dueOperatorWaitingEmails(
      items,
      (dependencies.now ?? (() => new Date()))(),
      delay,
      (dependencies.ledger ?? pushedEpisodes)(),
    )
  } catch (cause) {
    error(`hub: operator waiting email check failed: ${String(cause)}`)
    return
  }
  const port = readMachineValue('hub.port')
  for (const item of due) {
    try {
      const result = await (dependencies.push ?? hostedCreateOperatorWaitingEmail)({
        kind: item.kind,
        item_id: item.id,
        episode: item.episode,
        project: item.project,
        task_key: item.task_key,
        question: item.question,
        options: item.options,
        recommendation: item.recommendation,
        why: item.why,
        waiting_since: item.waiting_since,
        link: `http://127.0.0.1:${port}${operatorInboxPath(item.kind, item.id)}`,
        answer_command: item.answer_command,
      })
      if (result.status === 'failed') throw new Error(result.reason ?? 'hosted email failed')
      ;(dependencies.record ?? recordPushed)(item)
    } catch (cause) {
      error(`hub: operator waiting email push failed: ${String(cause)}`)
    }
  }
}
