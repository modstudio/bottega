import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES, PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../shared/embedded-assets.ts'
import {
  decideHubDatabasePath,
  implicitHubDatabaseCreationRefusal,
  missingHubDatabaseMessage,
  resolveHubRuntime,
  unauthorizedHubMigrationMessage,
} from './db.ts'

afterEach(() => registerEmbeddedAssets(null))

const livePath = '/nonexistent-live-hub-store/hub.db'
const tempPath = '/nonexistent-temp-hub-store/hub.db'

describe('hub database path decision', () => {
  test('test-process unset HUB_DB mutation: refuses the live fallback', () => {
    expect(() => decideHubDatabasePath(true, undefined, livePath)).toThrow(
      `test process refuses hub database: HUB_DB resolved <unset>; live store is ${livePath}\n` +
        'invariant: A test suite never falls back to the live hub database.\n' +
        'cleared by: set HUB_DB to a scratch store before importing hub/src/db.ts',
    )
  })

  test('test-process empty HUB_DB mutation: refuses the live fallback', () => {
    expect(() => decideHubDatabasePath(true, '', livePath)).toThrow(
      'test process refuses hub database: HUB_DB resolved <unset>',
    )
  })

  test('test-process temp HUB_DB mutation: uses the scratch store', () => {
    expect(decideHubDatabasePath(true, tempPath, livePath)).toBe(tempPath)
  })

  test('non-test unset HUB_DB mutation: falls back to the live store', () => {
    expect(decideHubDatabasePath(false, undefined, livePath)).toBe(livePath)
  })

  test('non-test empty HUB_DB mutation: falls back to the live store', () => {
    expect(decideHubDatabasePath(false, '', livePath)).toBe(livePath)
  })
})

test('the absent explicit-store refusal names the condition and explicit remedy', () => {
  expect(missingHubDatabaseMessage('/scratch/missing.db')).toBe(
    'hub database does not exist: /scratch/missing.db\n' +
      'invariant: An absent HUB_DB path is a mistake, not a request to create a store.\n' +
      'cleared by: unset HUB_DB to use the installation store, or name an existing database',
  )
})

test('implicit creation refuses explicit, linked, and unauthorized resolutions', () => {
  expect(implicitHubDatabaseCreationRefusal(false, true, false, '/state/hub.db')).toBeNull()
  expect(implicitHubDatabaseCreationRefusal(true, true, false, '/state/hub.db')).toBe(
    missingHubDatabaseMessage('/state/hub.db'),
  )
  expect(implicitHubDatabaseCreationRefusal(false, false, false, '/state/hub.db')).toBe(
    unauthorizedHubMigrationMessage('/state/hub.db'),
  )
  expect(implicitHubDatabaseCreationRefusal(false, true, true, '/state/hub.db')).toContain(
    'linked worktree',
  )
})

test('the migrate creation decision refuses an absent HUB_DB before touching its parent', () => {
  const parent = join(tmpdir(), `hub-explicit-${randomUUID()}`)
  const path = join(parent, 'hub.db')

  expect(implicitHubDatabaseCreationRefusal(true, true, false, path)).toBe(
    missingHubDatabaseMessage(path),
  )
  expect(existsSync(path)).toBeFalse()
  expect(existsSync(parent)).toBeFalse()
})

test('the unauthorized default-store migration refusal names the condition and remedy', () => {
  expect(unauthorizedHubMigrationMessage('/state/hub.db')).toBe(
    `refusing to migrate the default store: cannot establish an authorized ${PLATFORM_NAME} installation: /state/hub.db\n` +
      'invariant: A default store is created or migrated only by a checkout or an installed distribution.\n' +
      `cleared by: run hub migrate from a checkout or reinstall ${PLATFORM_NAME}`,
  )
})

test('an embedded distribution resolves and authorizes its store without git', () => {
  registerEmbeddedAssets({
    assets: {},
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-09-28T00:00:00Z',
      commit: 'fixture',
    },
  })
  const runtime = resolveHubRuntime('/$bunfs/root', { HOME: '/fixture-home' }, () => {
    throw new Error('git executable must not be consulted')
  })

  expect(runtime).toEqual({
    mainCheckout: null,
    linkedCheckout: false,
    livePath: `/fixture-home/.local/state/${PLATFORM_SLUG}/hub/${FROZEN_STATE_NAMES.hubDatabase}`,
    legacyPath: null,
    authorized: true,
  })
  expect(
    implicitHubDatabaseCreationRefusal(false, runtime.authorized, runtime.linkedCheckout),
  ).toBeNull()
})
