import { STATE_HOME_ENV } from '../../shared/state-directory.ts'

type SpawnEnvironment = Record<string, string | undefined>

export function testPostgresSpawnEnvironment(
  inherited: SpawnEnvironment,
  stateRoot: string,
  caller: SpawnEnvironment = {},
): SpawnEnvironment {
  const inheritedWithoutRecord = Object.fromEntries(
    Object.entries(inherited).filter(([name]) => !name.startsWith('BOTTEGA_RECORD_')),
  )
  return { ...inheritedWithoutRecord, ...caller, [STATE_HOME_ENV]: stateRoot }
}
