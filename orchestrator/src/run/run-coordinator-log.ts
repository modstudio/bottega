// concern: run-coordinator-log
/** Owns detached coordinator log paths, reads, and durable diagnostic shaping. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { RUNS_DIR } from './run-artifacts.ts'

const COORDINATOR_ERROR_TAIL_LIMIT = 2000
const SECRET_SHAPED_OUTPUT = '[withheld: secret-shaped content]'

/** A detached coordinator's diagnostics, derivable after only its run id survives. */
export const runCoordinatorLogPath = (id: number, runsDir = RUNS_DIR): string =>
  join(runsDir, `${id}.coordinator.log`)

/** Bound coordinator diagnostics only after checking the whole candidate tail for secrets. */
export function coordinatorErrorTail(output: string, limit = COORDINATOR_ERROR_TAIL_LIMIT): string {
  const trimmed = output.trim()
  if (!trimmed) return '(no output)'
  if (containsSecretShaped(trimmed)) return SECRET_SHAPED_OUTPUT
  if (trimmed.length <= limit) return trimmed
  const marker = '… [earlier output omitted] …\n'
  if (limit <= marker.length) return trimmed.slice(-limit)
  return `${marker}${trimmed.slice(-(limit - marker.length))}`
}

/** Shape the durable failure text for a coordinator that died during setup. */
export function coordinatorSetupError(id: number): string {
  let output = ''
  try {
    output = readFileSync(runCoordinatorLogPath(id), 'utf8')
  } catch {
    // A missing or unreadable log is still an observed setup death.
  }
  return `coordinator exited during setup before the agent started; last output: ${coordinatorErrorTail(output)}`
}
