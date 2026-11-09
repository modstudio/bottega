// concern: session identity
/** Resolves the current harness or operator session without depending on the database service. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { storedMachineId } from '../../../shared/machine-config.ts'
import {
  type CallerIdentityResolution,
  classifyCaller,
  resolveCallerIdentity,
} from '../caller-classification.ts'
import { DB_PATH } from './database-location.ts'

/** Identity result of the architect or local operator making this call. */
export const callerIdentity = (database?: Database): CallerIdentityResolution => {
  const caller = classifyCaller(process.env)
  if (caller.kind !== 'operator') return resolveCallerIdentity(caller, null)
  // An absent store has no identity to read. A store that exists and refuses to open must say
  // so: swallowing that refusal would let a command report emptiness for data it never saw.
  if (!database && !existsSync(DB_PATH)) return resolveCallerIdentity(caller, null)
  return resolveCallerIdentity(caller, storedMachineId())
}

/** Identity of the architect or local operator making this call. */
export const sessionId = (database?: Database): string | null => {
  const identity = callerIdentity(database)
  return identity.kind === 'identity' ? identity.session : null
}
