import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES, PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../shared/embedded-assets.ts'
import {
  assertHubStoreWritable,
  implicitHubDatabaseCreationRefusal,
  linkedCheckoutWriteRefusal,
  missingHubDatabaseMessage,
  resolveHubRuntime,
  unauthorizedHubMigrationMessage,
} from './db.ts'

afterEach(() => registerEmbeddedAssets(null))

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

test('implicit creation allows a linked checkout to initialize temporary state', () => {
  const path = join(tmpdir(), `hub-linked-scratch-${randomUUID()}`, 'hub.db')
  expect(implicitHubDatabaseCreationRefusal(false, false, true, path)).toBeNull()
})

test('a reader checkout can read the shared hub path but cannot write it', () => {
  const runtime = resolveHubRuntime(
    '/reader/clone',
    { HOME: '/reader/home', HUB_DB: '/operator/state/hub.db' },
    () => '/main/checkout',
  )

  expect(runtime.livePath).toBe('/operator/state/hub.db')
  expect(() => assertHubStoreWritable(runtime.linkedCheckout, runtime.livePath, '/tmp')).toThrow(
    'refusing to write hub rows to the shared main store from a linked worktree or borrowed clone\n' +
      'invariant: A linked-worktree or borrowed-clone binary reads the main hub store and never writes it.\n' +
      'cleared by: run the command from the main checkout, or set HUB_DB to a scratch copy',
  )
})

test('a linked checkout may write an isolated temporary hub store', () => {
  const path = join(tmpdir(), `hub-linked-write-${randomUUID()}`, 'hub.db')
  expect(linkedCheckoutWriteRefusal(true, path)).toBeNull()
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
      `cleared by: run ${PLATFORM_SLUG} machine migrate from a checkout or reinstall ${PLATFORM_NAME}`,
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
