// concern: workflows
/** Owns the durable cursor trail shape and facts derived from it. */

export type ClosedStep = {
  n: number
  slug: string
  note: string
  at: string
  review?: true
  evidence?: Array<{ flag: string; value: string }>
  deferred?: { id: number; floor: string; reason: string }
  satisfied?: number
  outcome?: string
  skipped?: { step: string; outcome: string[] }
  reentered?: { to: string; pass: number }
}

export type ArgumentReboundEvent = {
  event: 'argument-rebound'
  name: string
  oldValue: string
  newValue: string
  at: string
}

export type CursorTrailEntry = ClosedStep | ArgumentReboundEvent

export const isClosedStep = (entry: CursorTrailEntry): entry is ClosedStep => !('event' in entry)

export function completedWorkflowSummary(name: string, entries: CursorTrailEntry[]): string {
  const closed = entries.filter(isClosedStep)
  const reviews = closed
    .filter((step) => step.review)
    .map((step) => `For your review: ${step.n}. ${step.slug} — ${step.note}`)
  return [`${name} is finished: ${closed.length} steps closed.`, ...reviews].join('\n')
}

export const hasClosedStep = (trail: string): boolean =>
  (JSON.parse(trail) as CursorTrailEntry[]).some(isClosedStep)

export function currentStepActivatedAt(
  row: { ordinal: number; created_at: string; closed: string; step_slug: string },
  cursor: string,
): string {
  if (row.ordinal === 0) return row.created_at
  const preceding = (JSON.parse(row.closed) as CursorTrailEntry[])
    .filter(isClosedStep)
    .findLast((step) => step.n === row.ordinal)
  if (!preceding)
    throw new Error(
      `${cursor} has no activation record for step ${row.ordinal + 1} ${row.step_slug}`,
    )
  return preceding.at
}
