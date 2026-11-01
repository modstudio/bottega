import { STATE_HOME_ENV, type StateEnvironment } from '../../shared/state-directory.ts'

const STORE_PATH_ENVIRONMENT_NAMES = [
  'BOTTEGA_ORCHESTRATOR_DB',
  'BOTTEGA_RUNS',
  'BOTTEGA_HUB_DB',
] as const

function isStorePathEnvironmentName(name: string): boolean {
  return STORE_PATH_ENVIRONMENT_NAMES.some((candidate) => candidate === name)
}

export function testPostgresSpawnEnvironment(
  inherited: StateEnvironment,
  stateRoot: string,
  caller: StateEnvironment = {},
): StateEnvironment {
  const inheritedWithoutRecordOrStorePaths = Object.fromEntries(
    Object.entries(inherited).filter(
      ([name]) => !name.startsWith('BOTTEGA_RECORD_') && !isStorePathEnvironmentName(name),
    ),
  )
  const callerWithoutStorePaths = Object.fromEntries(
    Object.entries(caller).filter(([name]) => !isStorePathEnvironmentName(name)),
  )
  return {
    ...inheritedWithoutRecordOrStorePaths,
    ...callerWithoutStorePaths,
    [STATE_HOME_ENV]: stateRoot,
  }
}
