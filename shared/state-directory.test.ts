import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import {
  ensureHubLoginTokenDirectory,
  hubLoginTokenDirectory,
  legacyStoreRefusal,
  realPathForPotentialPath,
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveRunsDirectory,
  resolveStateRoot,
  STATE_HOME_ENV,
  temporaryStateStoreMigrationAllowed,
} from './state-directory.ts'

test('only a real path inside the OS temporary directory earns scratch migration authority', () => {
  const temporaryDirectory = realPathForPotentialPath(tmpdir())
  const scratch = mkdtempSync(join(tmpdir(), 'state-directory-scratch-'))
  const linked = join(scratch, 'linked-outside')
  try {
    symlinkSync(process.cwd(), linked)
    expect(
      temporaryStateStoreMigrationAllowed(
        realPathForPotentialPath(join(scratch, 'state', 'orchestrator.db')),
        temporaryDirectory,
      ),
    ).toBeTrue()
    expect(
      temporaryStateStoreMigrationAllowed(
        realPathForPotentialPath('/installation/state/orchestrator.db'),
        temporaryDirectory,
      ),
    ).toBeFalse()
    expect(
      temporaryStateStoreMigrationAllowed(
        realPathForPotentialPath(`${temporaryDirectory}-lookalike/orchestrator.db`),
        temporaryDirectory,
      ),
    ).toBeFalse()
    expect(
      temporaryStateStoreMigrationAllowed(
        realPathForPotentialPath(join(linked, 'orchestrator.db')),
        temporaryDirectory,
      ),
    ).toBeFalse()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the login-token directory refuses a symlink without changing its target', () => {
  const state = mkdtempSync(join(tmpdir(), 'state-directory-symlink-'))
  const target = join(state, 'target')
  const environment = { [STATE_HOME_ENV]: state }
  try {
    mkdirSync(join(state, 'hub'))
    mkdirSync(target, { mode: 0o755 })
    chmodSync(target, 0o755)
    symlinkSync(target, hubLoginTokenDirectory(environment))

    expect(() => ensureHubLoginTokenDirectory(environment)).toThrow(
      'hub login-token path is not a directory',
    )
    expect(lstatSync(hubLoginTokenDirectory(environment)).isSymbolicLink()).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o755)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

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
    expect(resolveOrchestratorDatabase({ BOTTEGA_ORCHESTRATOR_DB: '/tmp/orchestrator.db' })).toBe(
      '/tmp/orchestrator.db',
    )
    expect(resolveHubDatabase({ BOTTEGA_HUB_DB: '/tmp/hub.db' })).toBe('/tmp/hub.db')
  })

  test('empty per-file overrides are unset', () => {
    const env = {
      [STATE_HOME_ENV]: '/state',
      BOTTEGA_ORCHESTRATOR_DB: '',
      BOTTEGA_RUNS: '',
      BOTTEGA_HUB_DB: '',
    }
    expect(resolveOrchestratorDatabase(env)).toBe('/state/orchestrator/orchestrator.db')
    expect(resolveRunsDirectory(env)).toBe('/state/orchestrator/runs')
    expect(resolveHubDatabase(env)).toBe('/state/hub/hub.db')
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
  const refusal = legacyStoreRefusal(
    { store: true, wal: true, shm: true, journal: true, runs: true, destinationStore: false },
    {
      legacyStore: '/checkout/orchestrator/orchestrator.db',
      destinationStore: '/state/orchestrator/orchestrator.db',
      legacyRuns: '/checkout/orchestrator/runs',
      destinationRuns: '/state/orchestrator/runs',
    },
  )
  expect(refusal).toContain(
    '/checkout/orchestrator/orchestrator.db -> /state/orchestrator/orchestrator.db',
  )
  expect(refusal).toContain(
    '/checkout/orchestrator/orchestrator.db-wal -> /state/orchestrator/orchestrator.db-wal',
  )
  expect(refusal).toContain(
    '/checkout/orchestrator/orchestrator.db-shm -> /state/orchestrator/orchestrator.db-shm',
  )
  expect(refusal).toContain(
    '/checkout/orchestrator/orchestrator.db-journal -> /state/orchestrator/orchestrator.db-journal',
  )
  expect(refusal).toContain('/checkout/orchestrator/runs -> /state/orchestrator/runs')
  expect(refusal).toContain('check any existing destination before moving')
  expect(
    legacyStoreRefusal(
      { store: false, wal: false, shm: false, journal: false, destinationStore: false },
      { legacyStore: '/legacy', destinationStore: '/state' },
    ),
  ).toBeNull()
})

test('legacy store refusal lists only a remaining sidecar', () => {
  const refusal = legacyStoreRefusal(
    { store: false, wal: true, shm: false, journal: false, destinationStore: false },
    { legacyStore: '/legacy/orchestrator.db', destinationStore: '/state/orchestrator.db' },
  )
  expect(refusal).toContain('/legacy/orchestrator.db-wal -> /state/orchestrator.db-wal')
  expect(refusal).not.toContain('/legacy/orchestrator.db -> /state/orchestrator.db')
  expect(refusal).not.toContain('/legacy/orchestrator.db-shm')
})

test('legacy store refusal lists only a remaining runs directory', () => {
  const refusal = legacyStoreRefusal(
    { store: false, wal: false, shm: false, journal: false, runs: true, destinationStore: false },
    {
      legacyStore: '/legacy/orchestrator.db',
      destinationStore: '/state/orchestrator.db',
      legacyRuns: '/legacy/runs',
      destinationRuns: '/state/runs',
    },
  )
  expect(refusal).toContain('/legacy/runs -> /state/runs')
  expect(refusal).not.toContain('/legacy/orchestrator.db -> /state/orchestrator.db')
})

test('legacy store refusal applies even when the destination already exists', () => {
  const refusal = legacyStoreRefusal(
    { store: true, wal: false, shm: false, journal: false, destinationStore: true },
    {
      legacyStore: '/legacy',
      destinationStore: '/existing-state',
    },
  )
  expect(refusal).toContain('destination store already exists')
  expect(refusal).toContain('/legacy -> /existing-state')
})
