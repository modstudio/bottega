// concern: hosted-report-delivery
/** Plans, renders, and delivers one idempotent pass of hosted report subscriptions. */

import type { MeasureScope, Measures, MeasureWindow } from './measures.ts'

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

export type DeliverySubscription = {
  recipientUserId: string
  recipientName: string
  recipientEmail: string
  recipientIsMember: boolean
  scope: MeasureScope
  scopeName: string
  measures: Measures
}

export type RenderedReport = { subject: string; text: string; html: string }
export type DeliveryStatus = 'skipped' | 'failed'

export type DeliveryRepository = {
  discover(): Promise<DeliveryCandidate[]>
  load(candidate: DeliveryCandidate, period: DeliveryPeriod): Promise<DeliverySubscription>
  recipientIsMember(candidate: DeliveryCandidate, recipientUserId: string): Promise<boolean>
  recordFinal(
    candidate: DeliveryCandidate,
    period: DeliveryPeriod,
    input: { status: DeliveryStatus; reason: string; recipient?: string; items?: number },
  ): Promise<void>
  recordIntent(
    candidate: DeliveryCandidate,
    period: DeliveryPeriod,
    input: { recipient: string; items: number },
  ): Promise<string | null>
  recordOutcome(
    candidate: DeliveryCandidate,
    intentId: string,
    status: 'sent' | 'failed',
    reason?: string,
  ): Promise<void>
}

export type ReportMailClient = {
  send(input: RenderedReport & { to: string }): Promise<void>
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

const hours = (ms: number) => {
  const value = ms / 3_600_000
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${value === 1 ? 'hour' : 'hours'}`
}
const money = (value: number) => `$${value.toFixed(2)}`
const htmlEscape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

function localWindow(period: DeliveryPeriod, zone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return `${formatter.format(new Date(period.from))} to ${formatter.format(new Date(period.to))} (${zone})`
}

export function hasRecordedWork(measures: Measures) {
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
  const { measures } = subscription
  const lines = [
    `Report for ${subscription.scopeName}`,
    `Window: ${localWindow(period, candidate.zone)}`,
    '',
  ]
  if (measures.scope === 'person') {
    lines.push(
      `Recorded work for ${subscription.scopeName} was running for ${hours(measures.hoursRunning.unionMs)}.`,
    )
    lines.push(
      `${subscription.scopeName} started ${hours(measures.agentHours.sumMs).replace(' hour', ' agent-hour')}.`,
    )
    lines.push(
      `${subscription.scopeName} was in session for ${hours(measures.sessionTime.unionThenSumMs)}.`,
    )
  } else {
    lines.push(
      `Work was running for ${hours(measures.hoursRunning.unionMs)}. This measure is not additive.`,
    )
    lines.push(
      `Agents ran for ${hours(measures.agentHours.sumMs).replace(' hour', ' agent-hour')}.`,
    )
    lines.push(`People were in session for ${hours(measures.sessionTime.unionThenSumMs)}.`)
  }
  lines.push(measures.sessionTime.silenceAllowanceSentence)
  lines.push(`${hours(measures.sessionTime.uncountedSilenceMs)} of silence was uncounted.`)
  if (measures.agentHours.unknownShare)
    lines.push(
      `${hours(measures.agentHours.unknownShare.sumMs).replace(' hour', ' agent-hour')} had unknown attribution.`,
    )
  if (measures.sessionTime.unknownUser)
    lines.push(
      `${hours(measures.sessionTime.unknownUser.unionThenSumMs)} of session time had unknown attribution.`,
    )
  lines.push(`Agent runs cost ${money(measures.cost.vendorCostUsd)}.`)
  if ('shipped' in measures) {
    lines.push(
      `${measures.shipped.count} ${measures.shipped.count === 1 ? 'item landed' : 'items landed'}.`,
    )
    lines.push(
      measures.cycleTime
        ? `Median cycle time was ${hours(measures.cycleTime.medianMs)} across ${measures.cycleTime.n} ${measures.cycleTime.n === 1 ? 'item' : 'items'}.`
        : 'No landed item had enough recorded activity to calculate cycle time.',
    )
  }
  const text = lines.join('\n')
  const html = `<div>${lines.map((line) => (line ? `<p>${htmlEscape(line)}</p>` : '')).join('')}</div>`
  return { subject: `Report: ${subscription.scopeName}`, text, html }
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
  if (!subscription.recipientIsMember) return 'recipient is no longer a member of this space'
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
    recipient: subscription.recipientEmail,
    items: subscription.measures.hoursRunning.sample.intervalCount,
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
    print?: (text: string) => void
  },
  candidate: DeliveryCandidate,
  period: DeliveryPeriod,
  subscription: DeliverySubscription,
  rendered: RenderedReport,
): Promise<DeliveryResult> {
  if (input.dryRun) {
    input.print?.(
      `To: ${subscription.recipientEmail}\nSubject: ${rendered.subject}\n\n${rendered.text}`,
    )
    return 'dry-run'
  }
  const member = await input.repository.recipientIsMember(candidate, subscription.recipientUserId)
  if (!member) {
    await recordSkip(
      input.repository,
      candidate,
      period,
      subscription,
      'recipient is no longer a member of this space',
      false,
    )
    return 'skipped'
  }
  const intentId = await input.repository.recordIntent(candidate, period, {
    recipient: subscription.recipientEmail,
    items: subscription.measures.hoursRunning.sample.intervalCount,
  })
  if (!intentId) return 'duplicate'
  try {
    await input.mail.send({ ...rendered, to: subscription.recipientEmail })
    await input.repository.recordOutcome(candidate, intentId, 'sent')
    return 'sent'
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    await input.repository.recordOutcome(candidate, intentId, 'failed', reason)
    return 'failed'
  }
}

async function processCandidate(
  input: {
    repository: DeliveryRepository
    mail: ReportMailClient
    dryRun: boolean
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
