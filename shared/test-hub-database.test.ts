import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FROZEN_STATE_NAMES } from './brand.ts'
import {
  assertTestHubDatabasePath,
  mintTestHubDatabase,
  testHubDatabasePathRefusal,
} from './test-hub-database.ts'

describe('hub test database provenance rule', () => {
  test('refuses a store when no preload minted one', () => {
    expect(testHubDatabasePathRefusal(null, '/tmp/other/hub.db', [])).toContain(
      'preload minted <none minted>',
    )
  })

  test('refuses a different temporary store after minting', () => {
    const minted = '/canonical/private/tmp/hub-test-minted/hub.db'
    const changed = '/canonical/private/tmp/hub-test-other/hub.db'
    expect(testHubDatabasePathRefusal(minted, changed, [])).toContain(
      `HUB_DB resolved ${changed}; preload minted ${minted}`,
    )
  })

  test('refuses either live derivation even when it is the minted path', () => {
    const minted = '/canonical/private/tmp/live/hub.db'
    const overriddenLive = minted
    const defaultLive = '/Users/operator/.local/state/bottega/hub/hub.db'
    expect(testHubDatabasePathRefusal(minted, minted, [overriddenLive, defaultLive])).toContain(
      `HUB_DB resolved ${minted}`,
    )
    expect(
      testHubDatabasePathRefusal(defaultLive, defaultLive, [overriddenLive, defaultLive]),
    ).toContain(`HUB_DB resolved ${defaultLive}`)
  })

  test('accepts the matching minted path when it is not live', () => {
    const minted = '/canonical/private/tmp/hub-test-minted/hub.db'
    expect(testHubDatabasePathRefusal(minted, minted, ['/state/hub/hub.db'])).toBeNull()
  })

  test('canonicalizes a symlinked ancestor before checking minted identity', () => {
    const originalHubDb = process.env.HUB_DB
    const minted = mintTestHubDatabase(FROZEN_STATE_NAMES.hubDatabase)
    const configured = minted.database
    const mintedDirectory = dirname(configured)
    const heldDirectory = `${mintedDirectory}-held`
    const otherDirectory = mkdtempSync(join(tmpdir(), 'hub-test-other-'))
    renameSync(mintedDirectory, heldDirectory)
    symlinkSync(otherDirectory, mintedDirectory)
    try {
      expect(() => assertTestHubDatabasePath()).toThrow(
        `HUB_DB resolved ${join(realpathSync(otherDirectory), 'hub.db')}; preload minted ${configured}`,
      )
    } finally {
      rmSync(mintedDirectory)
      renameSync(heldDirectory, mintedDirectory)
      rmSync(mintedDirectory, { recursive: true, force: true })
      rmSync(otherDirectory, { recursive: true, force: true })
      if (originalHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = originalHubDb
    }
  })

  test('does not constrain production database selection', () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalHubDb = process.env.HUB_DB
    process.env.NODE_ENV = 'production'
    process.env.HUB_DB = '/etc/elsewhere.db'
    try {
      expect(() => assertTestHubDatabasePath()).not.toThrow()
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
      if (originalHubDb === undefined) delete process.env.HUB_DB
      else process.env.HUB_DB = originalHubDb
    }
  })
})
