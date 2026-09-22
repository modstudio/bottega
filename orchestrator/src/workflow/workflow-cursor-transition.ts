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
