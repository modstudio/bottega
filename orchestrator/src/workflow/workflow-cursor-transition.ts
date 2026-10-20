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

type ConditionalStep = { slug: string; when?: { step: string; outcome: string[] } }
type OutcomeTrailEntry = { slug: string; outcome?: string }

/** Select the next eligible ordinal and every conditional step skipped on the way. */
export function decideConditionalAdvance(
  steps: readonly ConditionalStep[],
  trail: readonly OutcomeTrailEntry[],
  nextOrdinal: number,
): { ordinal: number | null; skipped: Array<{ ordinal: number; step: ConditionalStep }> } {
  const skipped: Array<{ ordinal: number; step: ConditionalStep }> = []
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
