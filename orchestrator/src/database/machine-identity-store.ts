// concern: database
/** Stores the install's machine identity. Must not know callers, runs, or hosted records. */
import type { Database } from 'bun:sqlite'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { machineId as sharedMachineId, storedMachineId } from '../../../shared/machine-config.ts'

const MACHINE_ID_KEY = 'machine_id'

export function machineIdStored(database: Database): string | null {
  return (
    database
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(MACHINE_ID_KEY)?.value ?? null
  )
}

function removeStoredMachineId(database: Database): void {
  database.query('DELETE FROM schema_meta WHERE key=?').run(MACHINE_ID_KEY)
}

export function carryMachineIdentity(
  database: Database,
  transaction: <T>(fn: () => T) => T,
  env: ConfigEnvironment = process.env,
): string {
  const legacy = machineIdStored(database)
  const shared = storedMachineId(env)
  if (shared) {
    if (legacy && legacy !== shared)
      process.stderr.write(
        `removing stale orchestrator machine identity ${legacy}; shared machine identity is ${shared}\n`,
      )
    if (legacy) transaction(() => removeStoredMachineId(database))
    return shared
  }
  const id = sharedMachineId(legacy, env)
  if (legacy) transaction(() => removeStoredMachineId(database))
  return id
}
