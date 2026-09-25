// concern: operator-waiting-email-hosted
/** Persists idempotent email intent and outcome rows and renders operator-waiting mail. */

import { newRecordId } from '../../shared/record/schema.ts'
import { withHostedTenant } from './hosted-tasks.ts'
import type { ReportMailClient } from './report-delivery.ts'
import { sesReportMailClient } from './report-delivery-hosted.ts'

export type OperatorWaitingEmailInput = {
  kind: 'question' | 'workflow'
  item_id: number
  episode: string
  project: string
  task_key: string | null
  question: string
  options: string[]
  recommendation: string | null
  why: string | null
  waiting_since: string
  link: string
  answer_command: string
}

export type OperatorWaitingEmailResult = {
  id: string
  status: 'intent' | 'sent' | 'failed'
  reason: string | null
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

export async function sendOperatorWaitingEmail(
  databaseUrl: string,
  caller: { spaceId: string; userId: string },
  input: OperatorWaitingEmailInput,
  options: { mail?: ReportMailClient; now?: Date } = {},
): Promise<OperatorWaitingEmailResult> {
  const intent = await withHostedTenant(databaseUrl, caller, async (tx) => {
    const id = newRecordId()
    const inserted = rows<{ id: string; email: string }>(
      await tx`WITH inserted AS (
        INSERT INTO operator_waiting_email
          (id,space_id,user_id,kind,item_id,episode,project,task_key,question,options,
           recommendation,why,waiting_since,link,status,reason,created_at,sent_at)
        SELECT ${id}::uuid,${caller.spaceId}::uuid,${caller.userId}::uuid,${input.kind},
          ${input.item_id},${input.episode},${input.project},${input.task_key},${input.question},
          ${JSON.stringify(input.options)}::jsonb,${input.recommendation},${input.why},
          ${input.waiting_since}::timestamptz,${input.link},'intent',NULL,now(),NULL
        FROM "user" WHERE id=${caller.userId}::uuid
        ON CONFLICT(space_id,user_id,kind,item_id,episode) DO NOTHING RETURNING id,user_id
      ) SELECT inserted.id,u.email FROM inserted JOIN "user" u ON u.id=inserted.user_id`,
    )[0]
    if (inserted) return { ...inserted, fresh: true as const }
    const existing = rows<OperatorWaitingEmailResult>(
      await tx`SELECT id,status,reason FROM operator_waiting_email
        WHERE space_id=${caller.spaceId}::uuid AND user_id=${caller.userId}::uuid
          AND kind=${input.kind} AND item_id=${input.item_id} AND episode=${input.episode}`,
    )[0]
    if (!existing) throw new Error('authenticated user email is unavailable')
    return { ...existing, fresh: false as const }
  })
  if (!intent.fresh) return intent
  try {
    await (options.mail ?? sesReportMailClient()).send({
      ...renderOperatorWaitingEmail(input, options.now),
      to: [intent.email],
    })
    return await recordOperatorWaitingEmailOutcome(databaseUrl, caller, intent.id, 'sent', null)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return recordOperatorWaitingEmailOutcome(databaseUrl, caller, intent.id, 'failed', reason)
  }
}

async function recordOperatorWaitingEmailOutcome(
  databaseUrl: string,
  caller: { spaceId: string; userId: string },
  id: string,
  status: 'sent' | 'failed',
  reason: string | null,
) {
  return withHostedTenant(databaseUrl, caller, async (tx) => {
    const result = rows<OperatorWaitingEmailResult>(
      await tx`UPDATE operator_waiting_email SET status=${status},reason=${reason},
        sent_at=CASE WHEN ${status}='sent' THEN now() ELSE NULL END
        WHERE id=${id}::uuid AND user_id=${caller.userId}::uuid RETURNING id,status,reason`,
    )[0]
    if (!result) throw new Error(`operator waiting email intent ${id} was not found`)
    return result
  })
}
