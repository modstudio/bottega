import { expect, test } from 'bun:test'
import { closeDatabaseForFixture, db, registerOpenHooks } from './db.ts'

test('a writable open refuses when no hooks are registered', () => {
  closeDatabaseForFixture()
  const restore = registerOpenHooks({})
  try {
    expect(() => db()).toThrow(/registerStandardHooks\(\)/)
  } finally {
    restore()
  }
})
