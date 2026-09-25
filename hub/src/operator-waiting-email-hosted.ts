// concern: operator-waiting-email-hosted
/** Persists retryable email intents and outcomes and renders operator-waiting mail. */

import type { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import type {
  OperatorWaitingEmailInput,
  OperatorWaitingEmailResult,
} from './operator-waiting-email-contract.ts'
import { withHostedTenant } from './hosted-tasks.ts'
import type { ReportMailClient } from './report-delivery.ts'
import { sesReportMailClient } from './report-delivery-hosted.ts'

export type { OperatorWaitingEmailInput, OperatorWaitingEmailResult }

export const OPERATOR_EMAIL_INTENT_STALE_MS = 10 * 60_000
export const OPERATOR_EMAIL_MAX_ATTEMPTS = 5
export const OPERATOR_EMAIL_HOURLY_BUDGET = 20

type StoredIntent = OperatorWaitingEmailResult & {
  attempts: number
  updated_at: string | Date
}
type ClaimedIntent = OperatorWaitingEmailResult & {
  action: 'send' | 'return'
  email?: string
}

const resultOf = (intent: OperatorWaitingEmailResult): OperatorWaitingEmailResult => ({
  id: intent.id,
  status: intent.status,
  reason: intent.reason,
})

export class OperatorEmailBudgetExceededError extends Error {
  constructor() {
    super(`operator waiting email hourly budget of ${OPERATOR_EMAIL_HOURLY_BUDGET} reached`)
    this.name = 'OperatorEmailBudgetExceededError'
  }
}

const rows = <T>(value: unknown) => value as T[]
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

function waitedFor(waitingSince: string, now: Date) {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(waitingSince)) / 60_000))
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

export function renderOperatorWaitingEmail(input: OperatorWaitingEmailInput, now = new Date()) {
  const label = input.task_key ?? input.kind
  const subject = `Waiting on you: ${input.project} ${label}`
  const options = input.options.map(
    (option) => `${option}${option === input.recommendation ? ' (recommended)' : ''}`,
  )
  const waited = waitedFor(input.waiting_since, now)
  const text = [
    input.question,
    ...(options.length ? ['', 'Options:', ...options.map((option) => `- ${option}`)] : []),
    ...(input.why ? ['', `Why: ${input.why}`] : []),
    '',
    `Waiting for ${waited}.`,
    `Open the local inbox: ${input.link}`,
    'This link opens only on the machine running hub.',
    '',
    `Answer from that machine: ${input.answer_command}`,
  ].join('\n')
  const optionRows = options
    .map((option) => `<tr><td style="padding:4px 0;">${escapeHtml(option)}</td></tr>`)
    .join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;font-family:Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td><h1 style="font-size:20px;margin:0 0 16px;">${escapeHtml(subject)}</h1><p style="margin:0 0 16px;">${escapeHtml(input.question)}</p>${optionRows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${optionRows}</table>` : ''}${input.why ? `<p style="margin:0 0 16px;"><strong>Why:</strong> ${escapeHtml(input.why)}</p>` : ''}<p style="margin:0 0 16px;">Waiting for ${escapeHtml(waited)}.</p><p style="margin:0 0 8px;"><a href="${escapeHtml(input.link)}">Open the local inbox</a></p><p style="margin:0 0 16px;">This link opens only on the machine running hub.</p><p style="margin:0;"><strong>Answer from that machine:</strong><br><code>${escapeHtml(input.answer_command)}</code></p></td></tr></table></body></html>`
  return { subject, text, html }
}

export function decideOperatorWaitingEmailReclaim(
  intent: StoredIntent,
  now: Date,
): 'return' | 'reclaim' | 'abandon' {
  if (intent.status === 'sent' || intent.status === 'abandoned') return 'return'
  const updatedAt = new Date(intent.updated_at).getTime()
  if (
    intent.status === 'intent' &&
    Number.isFinite(updatedAt) &&
    now.getTime() - updatedAt < OPERATOR_EMAIL_INTENT_STALE_MS
  )
    return 'return'
  return intent.attempts < OPERATOR_EMAIL_MAX_ATTEMPTS ? 'reclaim' : 'abandon'
}

async function assertSendBudget(tx: SQL, userId: string, now: Date) {
  const cutoff = new Date(now.getTime() - 60 * 60_000).toISOString()
  const count = rows<{ count: number }>(
    await tx`SELECT count(*)::int AS count FROM operator_waiting_email
      WHERE user_id=${userId}::uuid AND updated_at >= ${cutoff}::timestamptz`,
  )[0]?.count
  if (Number(count) >= OPERATOR_EMAIL_HOURLY_BUDGET)
    throw new OperatorEmailBudgetExceededError()
}

/** Claims one send attempt inside an already tenant-bound transaction. */
export async function claimOperatorWaitingEmail(
  tx: SQL,
  caller: { spaceId: string; userId: string },
  input: OperatorWaitingEmailInput,
  now: Date,
): Promise<ClaimedIntent> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${caller.userId}, 0))`
  const existing = rows<StoredIntent>(
    await tx`SELECT id,status,reason,attempts,updated_at FROM operator_waiting_email
      WHERE space_id=${caller.spaceId}::uuid AND user_id=${caller.userId}::uuid
        AND kind=${input.kind} AND item_id=${input.item_id} AND episode=${input.episode}`,
  )[0]
  if (existing) {
    const decision = decideOperatorWaitingEmailReclaim(existing, now)
    if (decision === 'return') return { ...resultOf(existing), action: 'return' }
    if (decision === 'abandon') {
      const abandoned = rows<OperatorWaitingEmailResult>(
        await tx`UPDATE operator_waiting_email
          SET status='abandoned',updated_at=${now.toISOString()}::timestamptz
          WHERE id=${existing.id}::uuid AND status=${existing.status}
            AND attempts=${existing.attempts}
            AND updated_at=${new Date(existing.updated_at).toISOString()}::timestamptz
          RETURNING id,status,reason`,
      )[0]
      if (!abandoned) throw new Error(`operator waiting email intent ${existing.id} changed`)
      return { ...resultOf(abandoned), action: 'return' }
    }
    await assertSendBudget(tx, caller.userId, now)
    const reclaimed = rows<OperatorWaitingEmailResult & { email: string }>(
      await tx`UPDATE operator_waiting_email e
        SET status='intent',reason=NULL,attempts=attempts+1,
          updated_at=${now.toISOString()}::timestamptz,sent_at=NULL
        FROM "user" u
        WHERE e.id=${existing.id}::uuid AND e.user_id=u.id AND e.status=${existing.status}
          AND e.attempts=${existing.attempts}
          AND e.updated_at=${new Date(existing.updated_at).toISOString()}::timestamptz
        RETURNING e.id,e.status,e.reason,u.email`,
    )[0]
    if (!reclaimed) throw new Error(`operator waiting email intent ${existing.id} changed`)
    return { ...reclaimed, action: 'send' }
  }

  await assertSendBudget(tx, caller.userId, now)
  const id = newRecordId()
  const inserted = rows<OperatorWaitingEmailResult & { email: string }>(
    await tx`WITH inserted AS (
      INSERT INTO operator_waiting_email
        (id,space_id,user_id,kind,item_id,episode,project,task_key,question,options,
         recommendation,why,waiting_since,link,status,reason,attempts,created_at,updated_at,sent_at)
      SELECT ${id}::uuid,${caller.spaceId}::uuid,${caller.userId}::uuid,${input.kind},
        ${input.item_id},${input.episode},${input.project},${input.task_key},${input.question},
        ${JSON.stringify(input.options)}::jsonb,${input.recommendation},${input.why},
        ${input.waiting_since}::timestamptz,${input.link},'intent',NULL,1,
        ${now.toISOString()}::timestamptz,${now.toISOString()}::timestamptz,NULL
      FROM "user" WHERE id=${caller.userId}::uuid RETURNING id,user_id,status,reason
    ) SELECT inserted.id,inserted.status,inserted.reason,u.email
      FROM inserted JOIN "user" u ON u.id=inserted.user_id`,
  )[0]
  if (!inserted) throw new Error('authenticated user email is unavailable')
  return { ...inserted, action: 'send' }
}

/** Records one outcome inside an already tenant-bound transaction. */
export async function recordOperatorWaitingEmailOutcome(
  tx: SQL,
  caller: { userId: string },
  id: string,
  status: 'sent' | 'failed',
  reason: string | null,
  now: Date,
): Promise<OperatorWaitingEmailResult> {
  const result = rows<OperatorWaitingEmailResult>(
    await tx`UPDATE operator_waiting_email SET status=${status},reason=${reason},
      sent_at=CASE WHEN ${status}='sent' THEN ${now.toISOString()}::timestamptz ELSE NULL END,
      updated_at=${now.toISOString()}::timestamptz
      WHERE id=${id}::uuid AND user_id=${caller.userId}::uuid AND status='intent'
      RETURNING id,status,reason`,
  )[0]
  if (!result) throw new Error(`operator waiting email intent ${id} was not found`)
  return result
}

export async function sendOperatorWaitingEmail(
  databaseUrl: string,
  caller: { spaceId: string; userId: string },
  input: OperatorWaitingEmailInput,
  options: { mail?: ReportMailClient; now?: Date } = {},
): Promise<OperatorWaitingEmailResult> {
  const now = options.now ?? new Date()
  const intent = await withHostedTenant(databaseUrl, caller, (tx) =>
    claimOperatorWaitingEmail(tx, caller, input, now),
  )
  if (intent.action === 'return') return intent
  try {
    await (options.mail ?? sesReportMailClient()).send({
      ...renderOperatorWaitingEmail(input, now),
      to: [intent.email!],
    })
    return await withHostedTenant(databaseUrl, caller, (tx) =>
      recordOperatorWaitingEmailOutcome(tx, caller, intent.id, 'sent', null, now),
    )
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return withHostedTenant(databaseUrl, caller, (tx) =>
      recordOperatorWaitingEmailOutcome(tx, caller, intent.id, 'failed', reason, now),
    )
  }
}
