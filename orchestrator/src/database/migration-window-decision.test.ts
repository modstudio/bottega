import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideMigrationWindow,
  decideMigrationWindowClaim,
  MIGRATION_WINDOW_WAIT_MS,
} from './migration-window-decision.ts'

const behindRefusal =
  `refusing to open a store behind this binary's migration journal: 0172_additive\n` +
  `invariant: Only the main checkout's binary migrates the store.\n` +
  `cleared by: ${PLATFORM_SLUG} machine update (or ${PLATFORM_SLUG} machine migrate when no runs are in flight)`

describe('store-open migration window decision', () => {
  test('waits, bounds the wait, preserves the ordinary refusal, and opens when current', () => {
    const holder = { pid: 4321, liveness: 'live' as const }

    expect(
      decideMigrationWindow({ behind: true, refusal: behindRefusal, holder, elapsedMs: 500 }),
    ).toEqual({ action: 'wait' })

    expect(
      decideMigrationWindow({
        behind: true,
        refusal: behindRefusal,
        holder,
        elapsedMs: MIGRATION_WINDOW_WAIT_MS,
      }),
    ).toEqual({
      action: 'refuse',
      message:
        'refusing to open the store while machine update is migrating (holder pid 4321); retry this call when it finishes',
    })

    expect(
      decideMigrationWindow({
        behind: true,
        refusal: behindRefusal,
        holder: null,
        elapsedMs: 0,
      }),
    ).toEqual({ action: 'refuse', message: behindRefusal })

    expect(
      decideMigrationWindow({ behind: false, refusal: null, holder: null, elapsedMs: 0 }),
    ).toEqual({ action: 'open' })
  })

  test('waits for an existing claim and refuses with a retry remedy at the bound', () => {
    const holder = { migration: '0172_additive', pid: 4321, liveness: 'live' as const }
    expect(decideMigrationWindowClaim({ holder, elapsedMs: 500 })).toEqual({ action: 'wait' })
    expect(decideMigrationWindowClaim({ holder, elapsedMs: MIGRATION_WINDOW_WAIT_MS })).toEqual({
      action: 'refuse',
      message:
        'migration window is already active for 0172_additive (holder pid 4321); ' +
        're-run this command after that update finishes',
    })
  })
})
