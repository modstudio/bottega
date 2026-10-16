import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { testHubDatabasePathRefusal } from './test-hub-database.ts'

const temporaryDirectory = '/canonical/private/tmp'

describe('hub test database path rule', () => {
  test('refuses a live-looking path', () => {
    const liveStore = `/Users/operator/.local/state/${PLATFORM_SLUG}/hub/hub.db`
    expect(testHubDatabasePathRefusal(true, liveStore, liveStore, temporaryDirectory)).toContain(
      `HUB_DB resolved ${liveStore}`,
    )
  })

  test('refuses a path outside temporary storage regardless of the state root', () => {
    const overriddenStateRoot = `/var/empty/${PLATFORM_SLUG}-state`
    const configured = `${overriddenStateRoot}/hub/hub.db`
    expect(testHubDatabasePathRefusal(true, configured, configured, temporaryDirectory)).toContain(
      `HUB_DB resolved ${configured}`,
    )
  })

  test('accepts a path under temporary storage', () => {
    const configured = `${temporaryDirectory}/hub-test-abcd/hub.db`
    expect(testHubDatabasePathRefusal(true, configured, configured, temporaryDirectory)).toBeNull()
  })

  test('refuses an unset path', () => {
    expect(testHubDatabasePathRefusal(true, undefined, null, temporaryDirectory)).toContain(
      'HUB_DB resolved <unset>',
    )
  })

  test('accepts any path outside a test process', () => {
    const configured = '/etc/elsewhere.db'
    expect(testHubDatabasePathRefusal(false, configured, configured, temporaryDirectory)).toBeNull()
  })
})
