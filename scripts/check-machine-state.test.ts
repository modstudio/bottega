import { describe, expect, test } from 'bun:test'
import { FROZEN_STATE_NAMES } from '../shared/brand'
import { decideMachineState, type MachineStatePath } from './check-machine-state'

function paths(tracked: boolean, ...values: string[]): MachineStatePath[] {
  return values.map((path) => ({ path, tracked }))
}

describe('machine state decision', () => {
  test('rejects checkout state with a reason for every path', () => {
    const orch = FROZEN_STATE_NAMES.orchestratorDatabase
    const hub = FROZEN_STATE_NAMES.hubDatabase
    const runs = FROZEN_STATE_NAMES.runsDirectory
    expect(
      decideMachineState([
        ...paths(false, `orchestrator/${runs}/gate-timing.json`, `orchestrator/${runs}`),
        ...paths(
          false,
          `orchestrator/${orch}`,
          `orchestrator/${orch}-wal`,
          `orchestrator/${orch}-shm`,
          `hub/${hub}`,
          `hub/${hub}-wal`,
          `hub/${hub}-shm`,
          orch,
          hub,
          'cache.db.backup-20260917',
          'hub/.serve',
          'hub/.serve/7780.json',
          'orchestrator/.last-wake',
          'orchestrator/spawn-fallback.log',
        ),
        ...paths(
          true,
          'fixtures/arbitrary.db',
          'nested/arbitrary.db-wal',
          'arbitrary.db-shm',
          'fixtures/space name.db',
        ),
      ]),
    ).toEqual([
      { path: `orchestrator/${runs}/gate-timing.json`, reason: 'orchestrator run artifact' },
      { path: `orchestrator/${runs}`, reason: 'orchestrator run artifact' },
      { path: `orchestrator/${orch}`, reason: 'legacy database state' },
      { path: `orchestrator/${orch}-wal`, reason: 'legacy database state' },
      { path: `orchestrator/${orch}-shm`, reason: 'legacy database state' },
      { path: `hub/${hub}`, reason: 'legacy database state' },
      { path: `hub/${hub}-wal`, reason: 'legacy database state' },
      { path: `hub/${hub}-shm`, reason: 'legacy database state' },
      { path: orch, reason: 'legacy database state' },
      { path: hub, reason: 'legacy database state' },
      { path: 'cache.db.backup-20260917', reason: 'database backup state' },
      { path: 'hub/.serve', reason: 'serve lifecycle state' },
      { path: 'hub/.serve/7780.json', reason: 'serve lifecycle state' },
      { path: 'orchestrator/.last-wake', reason: 'wake state' },
      { path: 'orchestrator/spawn-fallback.log', reason: 'spawn fallback log' },
      { path: 'fixtures/arbitrary.db', reason: 'tracked database state' },
      { path: 'nested/arbitrary.db-wal', reason: 'tracked database state' },
      { path: 'arbitrary.db-shm', reason: 'tracked database state' },
      { path: 'fixtures/space name.db', reason: 'tracked database state' },
    ])
  })

  test('allows untracked databases outside legacy locations and skips node_modules', () => {
    expect(
      decideMachineState([
        ...paths(false, 'scratch/cache.db', 'scratch/cache.db-wal', 'scratch/cache.db-shm'),
        ...paths(
          true,
          'node_modules/package/cache.db',
          'hub/node_modules/package/cache.db.backup-now',
        ),
        ...paths(true, 'shared/state-directory.ts'),
      ]),
    ).toEqual([])
  })

  test('deduplicates paths gathered through more than one adapter source', () => {
    expect(
      decideMachineState([
        ...paths(true, 'orchestrator/.last-wake'),
        ...paths(false, './orchestrator/.last-wake'),
      ]),
    ).toEqual([{ path: 'orchestrator/.last-wake', reason: 'wake state' }])
  })
})
