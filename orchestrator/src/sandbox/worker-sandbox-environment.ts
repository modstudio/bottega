// concern: environment switches pinned before an SRT worker HOME or store view changes

import { HARNESS_ENV_FILE_ENV, PLATFORM_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import {
  HUB_DATABASE_ENV,
  ORCHESTRATOR_DATABASE_ENV,
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'

/** Explicitly disable host env-file reads inside every SRT worker. */
export function workerSandboxEnvironment(): Record<string, string> {
  return { [HARNESS_ENV_FILE_ENV]: '', [PLATFORM_ENV_FILE_ENV]: '' }
}

/** Pin operator state before a worker's isolated HOME changes implicit resolution. */
export function workerStateEnvironment(environment: StateEnvironment): Record<string, string> {
  return { [HUB_DATABASE_ENV]: resolveHubDatabase(environment) }
}

/** Pin the architect-authored workflow probe to the store its profile carves back. */
export function workflowProbeStateEnvironment(
  environment: StateEnvironment,
): Record<string, string> {
  return { [ORCHESTRATOR_DATABASE_ENV]: resolveOrchestratorDatabase(environment) }
}
