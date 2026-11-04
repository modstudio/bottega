import { createHash } from 'node:crypto'

/** The identity a recorded answer is reused by: a string state as given, an object as its JSON. */
export function typedQuestionStateIdentity(state: string | Record<string, unknown>): string {
  return createHash('sha256')
    .update(typeof state === 'string' ? state : JSON.stringify(state))
    .digest('hex')
}
