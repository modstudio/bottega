import { expect, test } from 'bun:test'
import {
  databaseLockHolder,
  formatDatabaseLockRefusal,
  isDatabaseLocked,
} from './database-lock-refusal.ts'
import type { WalWriteLockSampleResult } from './store-write-lock.ts'

test('a database lock refusal names the store, holder, and remedy', () => {
  expect(
    formatDatabaseLockRefusal({
      store: '/state/orchestrator/store.sqlite',
      holder: { pid: 39030, command: '/opt/bun /opt/app/main.ts secret run --token fixture-value' },
    }),
  ).toBe(
    'database write refused: database is locked\n' +
      'store: /state/orchestrator/store.sqlite\n' +
      'holder: pid 39030; command bun main.ts\n' +
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

test('the shared lock-holder decision names a found holder and each unavailable reason', () => {
  const held: WalWriteLockSampleResult = {
    supported: true,
    classification: 'held',
    holderPid: 4242,
    sampleCount: 5,
    samples: [4242, 4242, 4242, 4242, 4242],
  }
  expect(
    databaseLockHolder({
      sampled: held,
      command: '/opt/bun /opt/hub/src/cli.ts task set --pid 4242',
    }),
  ).toEqual({ pid: 4242, command: '/opt/bun /opt/hub/src/cli.ts task set --pid 4242' })
  expect(
    databaseLockHolder({
      sampled: { supported: false, reason: 'unsupported on linux', sampleCount: 0 },
      command: null,
    }),
  ).toEqual({ unavailable: 'unsupported on linux' })
  expect(
    databaseLockHolder({
      sampled: {
        supported: true,
        classification: 'free',
        holderPid: null,
        sampleCount: 3,
        samples: [null],
      },
      command: null,
    }),
  ).toEqual({ unavailable: 'the lock was released before its holder could be inspected' })
  expect(databaseLockHolder({ failed: new Error('shared-memory file is unreadable') })).toEqual({
    unavailable: 'lock-holder inspection failed: shared-memory file is unreadable',
  })
})
