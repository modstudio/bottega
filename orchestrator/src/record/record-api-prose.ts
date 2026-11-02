// concern: hosted prose policy
/** Supplies request identity and rollback policy to hosted prose gates. */

import type { RecordIdentity } from './record-auth.ts'

export function hostedProseOptions(identity: RecordIdentity | undefined): {
  displayName: string | null
  enabled: boolean
} {
  const name = identity?.user.name
  return {
    displayName: typeof name === 'string' ? name : null,
    enabled: process.env.BOTTEGA_PROSE_CHECK !== 'off',
  }
}
