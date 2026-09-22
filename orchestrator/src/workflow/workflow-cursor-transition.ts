export type CursorState = 'running' | 'awaiting-ruling' | 'done'

export type CursorValue = {
  ordinal: number
  stepSlug: string
  state: CursorState
}

export type CursorTransitionRequest =
  | { kind: 'serve'; ordinal: number; slug: string; expectedOrdinal: number; expectedSlug: string }
  | { kind: 'next'; total: number; nextSlug: string | null }

export type CursorTransition =
  | { action: 'serve'; ordinal: number; slug: string; move: boolean; resume: boolean }
  | { action: 'finish' }
  | { action: 'refuse'; reason: 'compose-first' | 'ahead' | 'state' | 'not-started' }

/** The cursor state machine. Persistence and wording belong to its adapters. */
export function decideCursorTransition(
  cursor: CursorValue | null,
  request: CursorTransitionRequest,
): CursorTransition {
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
        resume: request.ordinal === cursor.ordinal && cursor.state !== 'done',
      }
    if (request.ordinal === cursor.ordinal + 1)
      return {
        action: 'serve',
        ordinal: request.ordinal,
        slug: request.slug,
        move: true,
        resume: false,
      }
    return { action: 'refuse', reason: 'ahead' }
  }

  if (!cursor) return { action: 'refuse', reason: 'compose-first' }
  if (cursor.state === 'done') return { action: 'refuse', reason: 'state' }
  if (cursor.ordinal === request.total - 1) return { action: 'finish' }
  return {
    action: 'serve',
    ordinal: cursor.ordinal + 1,
    slug: request.nextSlug!,
    move: true,
    resume: false,
  }
}
