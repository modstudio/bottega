import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import {
  legacyStoreRefusal,
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveStateRoot,
  STATE_HOME_ENV,
} from './state-directory.ts'

describe('state root resolution', () => {
  test('platform override wins over XDG and HOME', () => {
    expect(
      resolveStateRoot({
        [STATE_HOME_ENV]: '/override/state',
        XDG_STATE_HOME: '/xdg/state',
        HOME: '/home/person',
      }),
    ).toBe('/override/state')
  })

  test('a relative platform override is refused with its remedy', () => {
    expect(() => resolveStateRoot({ [STATE_HOME_ENV]: 'relative/state' })).toThrow(
      `${STATE_HOME_ENV} must be an absolute state root; set it to an absolute path`,
    )
  })

  test('per-file overrides resolve without HOME', () => {
    expect(resolveOrchestratorDatabase({ ORCH_DB: '/tmp/orch.db' })).toBe('/tmp/orch.db')
    expect(resolveHubDatabase({ HUB_DB: '/tmp/hub.db' })).toBe('/tmp/hub.db')
  })

  test('absolute XDG state home wins over HOME', () => {
    expect(resolveStateRoot({ XDG_STATE_HOME: '/xdg/state', HOME: '/home/person' })).toBe(
      join('/xdg/state', PLATFORM_SLUG),
    )
  })

  test('HOME fallback also handles a relative XDG state home', () => {
    expect(resolveStateRoot({ XDG_STATE_HOME: 'relative', HOME: '/home/person' })).toBe(
      join('/home/person', '.local', 'state', PLATFORM_SLUG),
    )
  })

  test('missing HOME names both remedies', () => {
    expect(() => resolveStateRoot({})).toThrow(
      `set HOME, or set ${STATE_HOME_ENV} to an absolute state root`,
    )
  })
})

test('legacy store refusal names every orchestrator move', () => {
  const refusal = legacyStoreRefusal(false, true, {
    legacyStore: '/checkout/orchestrator/orch.db',
    destinationStore: '/state/orchestrator/orch.db',
    legacyRuns: '/checkout/orchestrator/runs',
    destinationRuns: '/state/orchestrator/runs',
  })
  expect(refusal).toContain('/checkout/orchestrator/orch.db -> /state/orchestrator/orch.db')
  expect(refusal).toContain('/checkout/orchestrator/orch.db-wal -> /state/orchestrator/orch.db-wal')
  expect(refusal).toContain('/checkout/orchestrator/orch.db-shm -> /state/orchestrator/orch.db-shm')
  expect(refusal).toContain('/checkout/orchestrator/runs -> /state/orchestrator/runs')
  expect(
    legacyStoreRefusal(true, true, {
      legacyStore: '/legacy',
      destinationStore: '/state',
    }),
  ).toBeNull()
})
