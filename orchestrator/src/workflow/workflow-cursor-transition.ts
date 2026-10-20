export type CursorState = 'running' | 'awaiting-ruling' | 'done' | 'abandoned'

export type CursorValue = {
  ordinal: number
  stepSlug: string
  state: CursorState
}

export type CursorTransitionRequest =
  | { kind: 'serve'; ordinal: number; slug: string }
  | { kind: 'next'; total: number; nextSlug: string | null }

export type CursorTransition =
  | { action: 'serve'; ordinal: number; slug: string; move: boolean; resume: boolean }
  | { action: 'finish' }
  | { action: 'refuse'; reason: 'compose-first' | 'ahead' | 'state' | 'not-started' }

export type CursorStartDecision = 'insert' | 'reuse' | 'retire'

export type OutcomeDecision = { action: 'allow' } | { action: 'refuse'; message: string }

/** Decide whether a supplied close outcome matches the current catalogue step. */
export function decideStepOutcome(
  stepSlug: string,
  allowed: readonly string[] | undefined,
  outcome: string | undefined,
): OutcomeDecision {
  if (!allowed?.length)
    return outcome === undefined
      ? { action: 'allow' }
      : {
          action: 'refuse',
          message: `step "${stepSlug}" declares no outcomes; omit --outcome`,
        }
  if (outcome === undefined)
    return {
      action: 'refuse',
      message: `step "${stepSlug}" requires --outcome <slug>; allowed values: ${allowed.join(', ')}`,
    }
  return allowed.includes(outcome)
    ? { action: 'allow' }
    : {
        action: 'refuse',
        message: `step "${stepSlug}" does not allow outcome "${outcome}"; allowed values: ${allowed.join(', ')}`,
      }
}

export const AUTOMATIC_REENTRY_LIMIT = 1

type ConditionalStep = {
  slug: string
  when?: { step: string; outcome: string[] }
  reenter?: { to: string; outcome: string }
}
type OutcomeTrailEntry = {
  slug: string
  outcome?: string
  reentered?: { to: string; pass: number }
}

export type ReentryRecord = { to: string; pass: number }

export type ConditionalAdvance = {
  ordinal: number | null
  skipped: Array<{ ordinal: number; step: ConditionalStep }>
  reentered?: ReentryRecord
  requireRuling: boolean
}

/** Pass number for a served step: 1 plus re-entries whose target is at or before it. */
export function stepPass(
  trail: readonly OutcomeTrailEntry[],
  steps: readonly { slug: string }[],
  currentOrdinal: number,
): number {
  return (
    1 +
    trail.filter((entry) => {
      if (!entry.reentered) return false
      const toOrdinal = steps.findIndex((step) => step.slug === entry.reentered!.to)
      return toOrdinal >= 0 && toOrdinal <= currentOrdinal
    }).length
  )
}

function forwardAdvance(
  steps: readonly ConditionalStep[],
  trail: readonly OutcomeTrailEntry[],
  nextOrdinal: number,
): Pick<ConditionalAdvance, 'ordinal' | 'skipped'> {
  const skipped: ConditionalAdvance['skipped'] = []
  let ordinal = nextOrdinal
  while (ordinal < steps.length) {
    const step = steps[ordinal]!
    if (!step.when) return { ordinal, skipped }
    const recorded = trail.findLast((entry) => entry.slug === step.when!.step)?.outcome
    if (recorded !== undefined && step.when.outcome.includes(recorded)) return { ordinal, skipped }
    skipped.push({ ordinal, step })
    ordinal += 1
  }
  return { ordinal: null, skipped }
}

/** Select the next ordinal, skips, any re-entry, and whether a ruling floor applies. */
export function decideConditionalAdvance(
  steps: readonly ConditionalStep[],
  trail: readonly OutcomeTrailEntry[],
  currentOrdinal: number,
  outcome: string | undefined,
): ConditionalAdvance {
  const current = steps[currentOrdinal]
  const reenter = current?.reenter
  if (reenter && outcome === reenter.outcome) {
    const toOrdinal = steps.findIndex((step) => step.slug === reenter.to)
    if (toOrdinal >= 0 && toOrdinal < currentOrdinal) {
      const count = trail.filter((entry) => entry.slug === current.slug && entry.reentered).length
      return {
        ordinal: toOrdinal,
        skipped: [],
        reentered: { to: reenter.to, pass: count + AUTOMATIC_REENTRY_LIMIT + 1 },
        requireRuling: count >= AUTOMATIC_REENTRY_LIMIT,
      }
    }
  }
  return {
    ...forwardAdvance(steps, [...trail, { slug: current?.slug ?? '', ...(outcome ? { outcome } : {}) }], currentOrdinal + 1),
    requireRuling: false,
  }
}

export const cursorValue = (
  ordinal: number,
  stepSlug: string,
  state: CursorState,
): CursorValue => ({
  ordinal,
  stepSlug,
  state,
})

/** Decide whether starting a cursor needs a new identity slot. */
export function decideCursorStart(state: CursorState | null): CursorStartDecision {
  if (state === 'done' || state === 'abandoned') return 'retire'
  return state ? 'reuse' : 'insert'
}

/** The cursor state machine. Persistence and wording belong to its adapters. */
export function decideCursorTransition(
  cursor: CursorValue | null,
  request: CursorTransitionRequest,
): CursorTransition {
  if (cursor?.state === 'done' || cursor?.state === 'abandoned')
    return { action: 'refuse', reason: 'state' }
  if (request.kind === 'serve') {
    if (!cursor) {
      return request.ordinal === 0
        ? { action: 'serve', ordinal: 0, slug: request.slug, move: true, resume: false }
        : { action: 'refuse', reason: 'compose-first' }
    }
    if (request.ordinal <= cursor.ordinal)
      return {
        action: 'serve',
        ordinal: cursor.ordinal,
        slug: cursor.stepSlug,
        move: false,
        resume: request.ordinal === cursor.ordinal,
      }
    return { action: 'refuse', reason: 'ahead' }
  }

  if (!cursor) return { action: 'refuse', reason: 'compose-first' }
  if (cursor.ordinal === request.total - 1) return { action: 'finish' }
  return {
    action: 'serve',
    ordinal: cursor.ordinal + 1,
    slug: request.nextSlug!,
    move: true,
    resume: false,
  }
}
