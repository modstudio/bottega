// concern: hosted-report-delivery
/** Plans, renders, and delivers one idempotent pass of hosted report subscriptions. */

import type { MeasureScope, Measures, MeasureWindow } from './measures.ts'
import { type GatheredReport, renderHtml, renderText } from './report-renderer.ts'

export type DeliveryCandidate = {
  subscriptionId: string
  spaceId: string
  cadence: 'daily' | 'weekly'
  hour: number
  weekday: string | null
  zone: string
  createdAt: string
  lastPeriodEnd: string | null
}

export type DeliveryPeriod = MeasureWindow & { key: string }

type DeliveryRecipient = {
  userId: string | null
  name: string
  email: string
  isMember: boolean
  unsubscribeToken?: string | null
}

export type DeliverySubscription = {
  recipients: DeliveryRecipient[]
  scope: MeasureScope
  scopeName: string
  measures: Measures
  report: GatheredReport
}

export type RenderedReport = { subject: string; text: string; html: string }
export type DeliveryStatus = 'skipped' | 'failed'

export type DeliveryRepository = {
  discover(): Promise<DeliveryCandidate[]>
  load(
    candidate: DeliveryCandidate,
    period: DeliveryPeriod,
    options?: { includeDisabled?: boolean },
  ): Promise<DeliverySubscription>
  recipientsAreMembers(candidate: DeliveryCandidate, recipientUserIds: string[]): Promise<boolean>
  recordFinal(
    candidate: DeliveryCandidate,
    period: DeliveryPeriod,
    input: { status: DeliveryStatus; reason: string; recipients?: string; items?: number },
  ): Promise<void>
  recordIntent(
    candidate: DeliveryCandidate,
    period: DeliveryPeriod,
    input: { recipients: DeliveryRecipient[]; items: number },
  ): Promise<string | null>
  recordOutcome(
    candidate: DeliveryCandidate,
    intentId: string,
    status: 'sent' | 'failed',
    reason?: string,
  ): Promise<void>
}

export type ReportMailClient = {
  send(
    input: RenderedReport & { to: string[]; headers?: { name: string; value: string }[] },
  ): Promise<void>
}

const WEEKDAY = new Map([
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
])

type DateParts = { year: number; month: number; day: number; hour: number; minute: number }

function zonedParts(value: Date, zone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

function zoneOffsetMs(at: Date, zone: string) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value
  const match = name?.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  if (!match) return 0
  const magnitude = (Number(match[2]) * 60 + Number(match[3])) * 60_000
  return match[1] === '-' ? -magnitude : magnitude
}

/** Convert a local wall-clock value to an instant. A skipped DST hour advances to the next real hour. */
function localInstant(parts: DateParts, zone: string) {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let value = new Date(wall - zoneOffsetMs(new Date(wall), zone))
  value = new Date(wall - zoneOffsetMs(value, zone))
  return value
}

function shiftedLocalDay(parts: DateParts, days: number): DateParts {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  }
}

function scheduledOnOrBefore(candidate: DeliveryCandidate, now: Date) {
  const today = { ...zonedParts(now, candidate.zone), hour: candidate.hour, minute: 0 }
  const wanted = candidate.weekday ? WEEKDAY.get(candidate.weekday) : undefined
  for (let back = 0; back <= 8; back++) {
    const local = shiftedLocalDay(today, -back)
    const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()
    if (candidate.cadence === 'weekly' && weekday !== wanted) continue
    const instant = localInstant(local, candidate.zone)
    if (instant.getTime() <= now.getTime()) return { instant, local }
  }
  throw new Error(`could not determine scheduled instant in ${candidate.zone}`)
}

export function duePeriod(candidate: DeliveryCandidate, now: Date): DeliveryPeriod | null {
  const end = scheduledOnOrBefore(candidate, now)
  const previousLocal = shiftedLocalDay(end.local, candidate.cadence === 'daily' ? -1 : -7)
  const previous = localInstant(previousLocal, candidate.zone)
  const created = new Date(candidate.createdAt)
  if (created.getTime() >= end.instant.getTime()) return null
  if (
    candidate.lastPeriodEnd &&
    new Date(candidate.lastPeriodEnd).getTime() >= end.instant.getTime()
  )
    return null
  return {
    from: new Date(Math.max(previous.getTime(), created.getTime())).toISOString(),
    to: end.instant.toISOString(),
    key: end.instant.toISOString(),
  }
}

/**
 * The window, worded the same wherever the sender runs.
 *
 * dateStyle and timeStyle delegate the separator to the host's locale data, and
 * it changed between CLDR versions, so the same subscription would say "at" on
 * one machine and "," on another. The parts are assembled here instead.
 */
function localWindow(period: DeliveryPeriod, zone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const stamp = (iso: string) => {
    const parts = new Map(
      formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
    )
    const at = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? ''
    return `${at('month')} ${at('day')}, ${at('year')} ${at('hour')}:${at('minute')} ${at('dayPeriod')}`
  }
  return `${stamp(period.from)} to ${stamp(period.to)} (${zone})`
}

function hasRecordedWork(measures: Measures) {
  return (
    measures.hoursRunning.sample.intervalCount > 0 ||
    ('shipped' in measures && measures.shipped.sample.eventCount > 0)
  )
}

export function renderReport(
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
  subscription: DeliverySubscription,
): RenderedReport {
  const presentation = {
    scopeName: subscription.scopeName,
    windowLine: `Window: ${localWindow(period, candidate.zone)}`,
    measures: subscription.measures,
  }
  return {
    subject: `Report: ${subscription.scopeName}`,
    text: renderText(subscription.report, new Map(), presentation),
    html: renderHtml(subscription.report, new Map(), presentation),
  }
}

type DeliveryResult = 'sent' | 'skipped' | 'failed' | 'dry-run' | 'duplicate'

async function recordFailure(
  repository: DeliveryRepository,
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
  cause: unknown,
  dryRun: boolean,
) {
  const reason = cause instanceof Error ? cause.message : String(cause)
  if (!dryRun) await repository.recordFinal(candidate, period, { status: 'failed', reason })
}

async function loadSubscription(
  repository: DeliveryRepository,
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
  dryRun: boolean,
) {
  try {
    return await repository.load(candidate, period)
  } catch (cause) {
    await recordFailure(repository, candidate, period, cause, dryRun)
    return null
  }
}

function skipReason(subscription: DeliverySubscription) {
  if (!subscription.recipients.length) return 'subscription has no recipients'
  if (subscription.recipients.some((recipient) => recipient.userId && !recipient.isMember))
    return 'a recipient is no longer a member of this space'
  if (!hasRecordedWork(subscription.measures)) return 'scope had no recorded work in this period'
  return null
}

async function recordSkip(
  repository: DeliveryRepository,
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
  subscription: DeliverySubscription,
  reason: string,
  dryRun: boolean,
) {
  if (dryRun) return
  await repository.recordFinal(candidate, period, {
    status: 'skipped',
    reason,
    recipients: subscription.recipients.map((recipient) => recipient.email).join(', '),
    items: subscription.report.items.length,
  })
}

async function renderSubscription(
  repository: DeliveryRepository,
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
  subscription: DeliverySubscription,
  dryRun: boolean,
) {
  try {
    return renderReport(candidate, period, subscription)
  } catch (cause) {
    await recordFailure(repository, candidate, period, cause, dryRun)
    return null
  }
}

async function dispatchReport(
  input: {
    repository: DeliveryRepository
    mail: ReportMailClient
    dryRun: boolean
    hostedOrigin?: string
    print?: (text: string) => void
  },
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
  subscription: DeliverySubscription,
  rendered: RenderedReport,
): Promise<DeliveryResult> {
  if (input.dryRun) {
    input.print?.(
      `To: ${subscription.recipients.map((recipient) => recipient.email).join(', ')}\nSubject: ${rendered.subject}\n\n${rendered.text}`,
    )
    return 'dry-run'
  }
  const members = await input.repository.recipientsAreMembers(
    candidate,
    subscription.recipients.flatMap((recipient) => (recipient.userId ? [recipient.userId] : [])),
  )
  if (!members) {
    await recordSkip(
      input.repository,
      candidate,
      period,
      subscription,
      'a recipient is no longer a member of this space',
      false,
    )
    return 'skipped'
  }
  const intentId = await input.repository.recordIntent(candidate, period, {
    recipients: subscription.recipients,
    items: subscription.report.items.length,
  })
  if (!intentId) return 'duplicate'
  try {
    for (const recipient of subscription.recipients) {
      const unsubscribeUrl = recipient.unsubscribeToken
        ? `${requiredHostedOrigin(input.hostedOrigin)}/unsubscribe/${recipient.unsubscribeToken}`
        : null
      await input.mail.send({
        ...rendered,
        text: unsubscribeUrl ? `${rendered.text}\n\nUnsubscribe: ${unsubscribeUrl}` : rendered.text,
        html: unsubscribeUrl
          ? rendered.html.replace(
              '</body>',
              `<p><a href="${unsubscribeUrl}">Unsubscribe</a></p></body>`,
            )
          : rendered.html,
        to: [recipient.email],
        headers: unsubscribeUrl
          ? [
              { name: 'List-Unsubscribe', value: `<${unsubscribeUrl}>` },
              { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
            ]
          : undefined,
      })
    }
    await input.repository.recordOutcome(candidate, intentId, 'sent')
    return 'sent'
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    await input.repository.recordOutcome(candidate, intentId, 'failed', reason)
    return 'failed'
  }
}

function requiredHostedOrigin(origin?: string) {
  const value = origin?.replace(/\/$/, '')
  if (!value) throw new Error('HUB_HOSTED_URL is required for email-recipient unsubscribe links')
  if (!value.startsWith('https://'))
    throw new Error('HUB_HOSTED_URL must use https for email-recipient unsubscribe links')
  return value
}

async function processCandidate(
  input: {
    repository: DeliveryRepository
    mail: ReportMailClient
    dryRun: boolean
    hostedOrigin?: string
    print?: (text: string) => void
  },
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
): Promise<DeliveryResult> {
  const subscription = await loadSubscription(input.repository, candidate, period, input.dryRun)
  if (!subscription) return 'failed'
  const reason = skipReason(subscription)
  if (reason) {
    await recordSkip(input.repository, candidate, period, subscription, reason, input.dryRun)
    return 'skipped'
  }
  const rendered = await renderSubscription(
    input.repository,
    candidate,
    period,
    subscription,
    input.dryRun,
  )
  if (!rendered) return 'failed'
  return dispatchReport(input, candidate, period, subscription, rendered)
}

export async function runReportDeliveryPass(input: {
  repository: DeliveryRepository
  mail: ReportMailClient
  now?: Date
  dryRun?: boolean
  print?: (text: string) => void
  hostedOrigin?: string
}) {
  const now = input.now ?? new Date()
  const result = { due: 0, sent: 0, skipped: 0, failed: 0 }
  for (const candidate of await input.repository.discover()) {
    const period = duePeriod(candidate, now)
    if (!period) continue
    result.due++
    const outcome = await processCandidate(
      { ...input, dryRun: input.dryRun ?? false },
      candidate,
      period,
    )
    if (outcome === 'sent') result.sent++
    if (outcome === 'skipped') result.skipped++
    if (outcome === 'failed') result.failed++
  }
  return result
}
