import { engagedMs, type Span, union } from '../../shared/interval.ts'

/** Ten minutes. Not a setting. Printed beside any session number. */
export const SILENCE_ALLOWANCE_MS = 10 * 60_000
export const SILENCE_ALLOWANCE_SENTENCE = 'Silences longer than ten minutes are not counted.'

export type MeasureWindow = { from: string; to: string }
export type MeasureScope =
  | { kind: 'space' }
  | { kind: 'project'; project: string }
  | { kind: 'person'; userId: string; project?: string }

export type MeasureInterval = {
  source: string
  startAt: string
  endAt: string
  open: number
  userId: string | null
  taskKey: string | null
  project: string | null
  vendorTokens: number
  vendorCostUsd: number | null
}

export type MeasureStatusEvent = {
  taskKey: string
  project: string
  at: string
  toStatus: string
}

export type MeasureRows = {
  intervals: MeasureInterval[]
  events: MeasureStatusEvent[]
}

type HoursRunning = {
  notAdditive: true
  unionMs: number
  sample: { intervalCount: number }
  from: { startedIntervals: number; sessionIntervals: number }
}

type AgentHours = {
  from: 'started'
  sumMs: number
  sample: { intervalCount: number }
  unknownShare?: { intervalCount: number; sumMs: number }
}

type SessionTime = {
  from: 'session'
  unionThenSumMs: number
  uncountedSilenceMs: number
  sample: { intervalCount: number; userCount: number }
  silenceAllowanceMs: number
  silenceAllowanceSentence: string
  unknownUser?: {
    unionThenSumMs: number
    uncountedSilenceMs: number
    sample: { intervalCount: number }
  }
}

type Cost = {
  from: 'started'
  vendorCostUsd: number
  vendorTokens: number
  sample: { intervalCount: number }
  unknownShare?: { vendorCostUsd: number; vendorTokens: number; intervalCount: number }
}

type Shipped = {
  count: number
  sample: { taskCount: number; eventCount: number }
}

type CycleTime = {
  medianMs: number
  p90Ms: number
  n: number
}

type SharedMeasures = {
  hoursRunning: HoursRunning
  agentHours: AgentHours
  sessionTime: SessionTime
  cost: Cost
}

type PersonMeasures = SharedMeasures & { scope: 'person' }
type SpaceOrProjectMeasures = SharedMeasures & {
  scope: 'space' | 'project'
  shipped: Shipped
  cycleTime?: CycleTime
}
export type Measures = PersonMeasures | SpaceOrProjectMeasures

const at = (iso: string) => new Date(iso).getTime()

function inScope(interval: MeasureInterval, scope: MeasureScope): boolean {
  if (scope.kind === 'project') return interval.project === scope.project
  if (scope.kind === 'person')
    return (
      interval.userId === scope.userId && (!scope.project || interval.project === scope.project)
    )
  return true
}

function eventInScope(event: MeasureStatusEvent, scope: MeasureScope): boolean {
  if (scope.kind === 'project') return event.project === scope.project
  return scope.kind !== 'person'
}

function clipSpan(start: number, end: number, open: number, from: number, to: number): Span | null {
  const rawEnd = open ? Math.max(end, to) : end
  const clippedStart = Math.max(start, from)
  const clippedEnd = Math.min(rawEnd, to)
  if (clippedStart >= clippedEnd) return null
  return { start: clippedStart, end: clippedEnd }
}

function clipped(
  interval: MeasureInterval,
  from: number,
  to: number,
): (Span & { interval: MeasureInterval }) | null {
  const span = clipSpan(at(interval.startAt), at(interval.endAt), interval.open, from, to)
  return span ? { ...span, interval } : null
}

function duration(span: Span): number {
  return span.end - span.start
}

/** Gap leftover after removing the merged overlapping agent spans. */
export function leftoverSilence(gap: Span, waiting: Span[]): Span[] {
  const cuts = union(
    waiting
      .filter((span) => span.start < gap.end && span.end > gap.start)
      .map((span) => ({
        start: Math.max(span.start, gap.start),
        end: Math.min(span.end, gap.end),
      })),
  )
  const leftover: Span[] = []
  let cursor = gap.start
  for (const cut of cuts) {
    if (cut.start > cursor) leftover.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (cursor < gap.end) leftover.push({ start: cursor, end: gap.end })
  return leftover
}

/**
 * The allowance applies once to a gap, not to each piece the waiting cut it into.
 *
 * Per-piece credit would make a one-minute agent run in the middle of a long
 * silence split it in two and credit the allowance twice, so more agent activity
 * would read as more attention. One silence gets one allowance however it is cut.
 */
function creditSilence(pieces: Span[]): { creditedMs: number; uncountedMs: number } {
  const total = pieces.reduce((sum, piece) => sum + duration(piece), 0)
  if (total <= 0) return { creditedMs: 0, uncountedMs: 0 }
  const creditedMs = Math.min(total, SILENCE_ALLOWANCE_MS)
  return { creditedMs, uncountedMs: total - creditedMs }
}

function sessionForSpans(
  claude: Span[],
  waiting: Span[],
): {
  sessionMs: number
  uncountedSilenceMs: number
} {
  const merged = union(claude)
  let sessionMs = engagedMs(merged)
  let uncountedSilenceMs = 0
  for (let index = 0; index < merged.length - 1; index++) {
    const gap = { start: merged[index]!.end, end: merged[index + 1]!.start }
    if (gap.end <= gap.start) continue
    const credited = creditSilence(leftoverSilence(gap, waiting))
    sessionMs += credited.creditedMs
    uncountedSilenceMs += credited.uncountedMs
  }
  return { sessionMs, uncountedSilenceMs }
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]!
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! * (1 - (pos - lo)) + sorted[hi]! * (pos - lo)
}

function hoursRunningOf(rows: (Span & { interval: MeasureInterval })[]): HoursRunning {
  return {
    notAdditive: true,
    unionMs: engagedMs(rows),
    sample: { intervalCount: rows.length },
    from: {
      startedIntervals: rows.filter((row) => row.interval.source === 'orch').length,
      sessionIntervals: rows.filter((row) => row.interval.source === 'claude').length,
    },
  }
}

function agentHoursOf(orch: (Span & { interval: MeasureInterval })[], person: boolean): AgentHours {
  const unknown = orch.filter((row) => !row.interval.userId)
  const measure: AgentHours = {
    from: 'started',
    sumMs: orch.reduce((sum, row) => sum + duration(row), 0),
    sample: { intervalCount: orch.length },
  }
  if (!person)
    measure.unknownShare = {
      intervalCount: unknown.length,
      sumMs: unknown.reduce((sum, row) => sum + duration(row), 0),
    }
  return measure
}

function sessionTimeOf(
  claude: (Span & { interval: MeasureInterval })[],
  orch: (Span & { interval: MeasureInterval })[],
  person: boolean,
): SessionTime {
  const waitingByUser = new Map<string, Span[]>()
  for (const row of orch) {
    if (!row.interval.userId) continue
    const list = waitingByUser.get(row.interval.userId) ?? []
    list.push(row)
    waitingByUser.set(row.interval.userId, list)
  }
  const byUser = new Map<string, Span[]>()
  const unknownClaude: Span[] = []
  for (const row of claude) {
    if (!row.interval.userId) {
      unknownClaude.push(row)
      continue
    }
    const list = byUser.get(row.interval.userId) ?? []
    list.push(row)
    byUser.set(row.interval.userId, list)
  }
  let unionThenSumMs = 0
  let uncountedSilenceMs = 0
  for (const [userId, spans] of byUser) {
    const credited = sessionForSpans(spans, union(waitingByUser.get(userId) ?? []))
    unionThenSumMs += credited.sessionMs
    uncountedSilenceMs += credited.uncountedSilenceMs
  }
  const unknown = sessionForSpans(unknownClaude, [])
  const measure: SessionTime = {
    from: 'session',
    unionThenSumMs,
    uncountedSilenceMs,
    sample: { intervalCount: claude.length, userCount: byUser.size },
    silenceAllowanceMs: SILENCE_ALLOWANCE_MS,
    silenceAllowanceSentence: SILENCE_ALLOWANCE_SENTENCE,
  }
  if (!person)
    measure.unknownUser = {
      unionThenSumMs: unknown.sessionMs,
      uncountedSilenceMs: unknown.uncountedSilenceMs,
      sample: { intervalCount: unknownClaude.length },
    }
  return measure
}

function costOf(orch: (Span & { interval: MeasureInterval })[], person: boolean): Cost {
  const fold = (rows: (Span & { interval: MeasureInterval })[]) => ({
    vendorCostUsd: rows.reduce((sum, row) => sum + (row.interval.vendorCostUsd ?? 0), 0),
    vendorTokens: rows.reduce((sum, row) => sum + row.interval.vendorTokens, 0),
    intervalCount: rows.length,
  })
  const unknown = orch.filter((row) => !row.interval.userId)
  const totals = fold(orch)
  const measure: Cost = {
    from: 'started',
    vendorCostUsd: totals.vendorCostUsd,
    vendorTokens: totals.vendorTokens,
    sample: { intervalCount: totals.intervalCount },
  }
  if (!person) {
    const unknownTotals = fold(unknown)
    measure.unknownShare = {
      vendorCostUsd: unknownTotals.vendorCostUsd,
      vendorTokens: unknownTotals.vendorTokens,
      intervalCount: unknownTotals.intervalCount,
    }
  }
  return measure
}

function doneEvents(events: MeasureStatusEvent[], from: number, to: number): MeasureStatusEvent[] {
  return events
    .filter((event) => event.toStatus === 'done' && at(event.at) >= from && at(event.at) < to)
    .sort((left, right) => at(left.at) - at(right.at) || left.taskKey.localeCompare(right.taskKey))
}

function shippedOf(events: MeasureStatusEvent[], from: number, to: number): Shipped {
  const done = doneEvents(events, from, to)
  const keys = new Set(done.map((event) => event.taskKey))
  return { count: keys.size, sample: { taskCount: keys.size, eventCount: done.length } }
}

function cycleTimeOf(
  rows: MeasureRows,
  events: MeasureStatusEvent[],
  from: number,
  to: number,
): CycleTime | undefined {
  const closeAt = new Map<string, number>()
  for (const event of doneEvents(events, from, to)) {
    if (!closeAt.has(event.taskKey)) closeAt.set(event.taskKey, at(event.at))
  }
  const firstStart = new Map<string, number>()
  for (const interval of rows.intervals) {
    if (!interval.taskKey || !closeAt.has(interval.taskKey)) continue
    const start = at(interval.startAt)
    const current = firstStart.get(interval.taskKey)
    if (current === undefined || start < current) firstStart.set(interval.taskKey, start)
  }
  const samples: number[] = []
  for (const [taskKey, close] of closeAt) {
    const start = firstStart.get(taskKey)
    if (start === undefined || start >= close) continue
    samples.push(close - start)
  }
  if (!samples.length) return undefined
  return { medianMs: quantile(samples, 0.5), p90Ms: quantile(samples, 0.9), n: samples.length }
}

export function computeMeasures(
  rows: MeasureRows,
  window: MeasureWindow,
  scope: MeasureScope,
): Measures {
  const from = at(window.from)
  const to = at(window.to)
  const spans = rows.intervals
    .filter((interval) => inScope(interval, scope))
    .flatMap((interval) => {
      const span = clipped(interval, from, to)
      return span ? [span] : []
    })
  const orch = spans.filter((row) => row.interval.source === 'orch')
  const claude = spans.filter((row) => row.interval.source === 'claude')
  const person = scope.kind === 'person'
  const events = rows.events.filter((event) => eventInScope(event, scope))
  const shared: SharedMeasures = {
    hoursRunning: hoursRunningOf(spans),
    agentHours: agentHoursOf(orch, person),
    sessionTime: sessionTimeOf(claude, orch, person),
    cost: costOf(orch, person),
  }
  if (person) return { scope: 'person', ...shared }
  const cycleTime = cycleTimeOf(rows, events, from, to)
  return {
    scope: scope.kind,
    ...shared,
    shipped: shippedOf(events, from, to),
    ...(cycleTime ? { cycleTime } : {}),
  }
}
