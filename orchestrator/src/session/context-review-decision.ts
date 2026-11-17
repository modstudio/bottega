// concern: context-review-decision
/** Pure timing, staleness, and ordering policy for timed context reviews. */

export const CONTEXT_REVIEW_WINDOW_MS = 7 * 24 * 60 * 60_000
export const CONTEXT_REVIEW_MIN_MS = 10 * 60_000
export const CONTEXT_REVIEW_MAX_MS = 60 * 60_000
export const CONTEXT_REVIEW_MIN_SAMPLES = 5
export const CONTEXT_REVIEW_HOOK_TIMEOUT_SECONDS = 5

type ContextReviewItem = {
  recordId: string
  id: string
  kind: 'ruling' | 'position' | 'fact' | 'pointer'
  holder: string
  updatedAt: number
  body: string
}

type ContextReviewCursor = {
  holder: string
  stepStartedAt: number
}

export type ContextReviewFacts = {
  now: number
  sessionStartedAt: number
  lastReviewAt: number | null
  lastBriefInjectionAt: number | null
  compactionGaps: readonly { at: number; gapMs: number }[]
  items: readonly ContextReviewItem[]
  openCursors: readonly ContextReviewCursor[]
  carriedTaskHolders: readonly string[]
  doneTaskKeys: readonly string[]
}

export type ContextReviewOrderedItem = ContextReviewItem & {
  flagged: boolean
  reason: string | null
}

export type ContextReviewDecision = {
  due: boolean
  nextDueAt: number
  intervalMs: number
  items: ContextReviewOrderedItem[]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function contextReviewInterval(
  now: number,
  gaps: readonly { at: number; gapMs: number }[],
): number {
  const recent = gaps
    .filter((gap) => gap.at >= now - CONTEXT_REVIEW_WINDOW_MS)
    .map((gap) => gap.gapMs)
  if (recent.length < CONTEXT_REVIEW_MIN_SAMPLES) return CONTEXT_REVIEW_MAX_MS
  return Math.round(
    Math.min(CONTEXT_REVIEW_MAX_MS, Math.max(CONTEXT_REVIEW_MIN_MS, median(recent))),
  )
}

function namedDoneTask(body: string, doneTaskKeys: readonly string[]): string | null {
  return (
    doneTaskKeys.find((key) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^A-Z0-9-])${escaped}([^A-Z0-9-]|$)`, 'i').test(body)
    }) ?? null
  )
}

function staleReason(
  item: ContextReviewItem,
  facts: Pick<ContextReviewFacts, 'openCursors' | 'carriedTaskHolders' | 'doneTaskKeys'>,
): string | null {
  if (item.kind === 'ruling' || item.kind === 'position') return null
  const cursor = facts.openCursors.find((candidate) => candidate.holder === item.holder)
  if (cursor && item.updatedAt < cursor.stepStartedAt) return 'older than the current step'
  const doneTask = namedDoneTask(item.body, facts.doneTaskKeys)
  if (doneTask) return `names done task ${doneTask}`
  const holdersWithOpenCursor = new Set(facts.carriedTaskHolders)
  if (item.holder.startsWith('task:') && !holdersWithOpenCursor.has(item.holder))
    return 'holder has no open cursor'
  return null
}

export function decideContextReview(facts: ContextReviewFacts): ContextReviewDecision {
  const intervalMs = contextReviewInterval(facts.now, facts.compactionGaps)
  const baseline = Math.max(
    facts.sessionStartedAt,
    facts.lastReviewAt ?? Number.NEGATIVE_INFINITY,
    facts.lastBriefInjectionAt ?? Number.NEGATIVE_INFINITY,
  )
  const nextDueAt = baseline + intervalMs
  const items = facts.items.map((item) => {
    const reason = staleReason(item, facts)
    return { ...item, flagged: reason !== null, reason }
  })
  items.sort((left, right) => Number(right.flagged) - Number(left.flagged))
  return { due: facts.now >= nextDueAt, nextDueAt, intervalMs, items }
}
