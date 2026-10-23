import { expect, test } from 'bun:test'
import { closeDatabaseForFixture, db, registerOpenHooks, withReadOnlyDatabaseAccess } from './db.ts'

test('a writable open refuses when no hooks are registered', () => {
  closeDatabaseForFixture()
  const restore = registerOpenHooks({})
  try {
    expect(() => db()).toThrow(/registerStandardHooks\(\)/)
  } finally {
    restore()
  }
})

test('a read-only command neither enters writable-open hooks nor permits a write', () => {
  closeDatabaseForFixture()
  let entered = 0
  const restore = registerOpenHooks({
    afterWritableOpen: [() => entered++],
  })
  try {
    withReadOnlyDatabaseAccess(() => {
      expect(db().query('SELECT COUNT(*) AS count FROM run').get()).toBeTruthy()
      expect(() => db().query('UPDATE run SET status=status').run()).toThrow(
        'attempt to write a readonly database',
      )
    })
    expect(entered).toBe(0)
  } finally {
    restore()
    closeDatabaseForFixture()
  }
})
