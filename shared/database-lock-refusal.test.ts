import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { formatDatabaseLockRefusal, isDatabaseLocked } from './database-lock-refusal.ts'

test('a database lock refusal names the store, holder, and remedy', () => {
  expect(
    formatDatabaseLockRefusal({
      store: '/state/orchestrator/store.sqlite',
      holder: { pid: 39030, command: `${PLATFORM_SLUG} run list --json` },
    }),
  ).toBe(
    'database write refused: database is locked\n' +
      'store: /state/orchestrator/store.sqlite\n' +
      `holder: pid 39030; command ${PLATFORM_SLUG} run list --json\n` +
      'cleared by: wait for the holder to finish, then retry the command',
  )
  expect(isDatabaseLocked({ code: 'SQLITE_BUSY' })).toBeTrue()
  expect(isDatabaseLocked({ code: 'SQLITE_LOCKED' })).toBeTrue()
  expect(isDatabaseLocked({ message: 'database table is locked' })).toBeTrue()
  expect(
    formatDatabaseLockRefusal({
      store: '/state/hub/store.sqlite',
      holder: { unavailable: 'inspection unavailable' },
    }),
  ).toContain('holder: unknown (inspection unavailable)')
})
