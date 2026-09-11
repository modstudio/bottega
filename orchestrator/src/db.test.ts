import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applySchemaForFixture, closeDatabaseForFixture, db, registerOpenHooks } from './db.ts'

test('a writable open refuses when no hooks are registered', () => {
  closeDatabaseForFixture()
  const restore = registerOpenHooks({})
  try {
    expect(() => db()).toThrow(/registerStandardHooks\(\)/)
  } finally {
    restore()
  }
})

test('registered hooks run in registration order', () => {
  const calls: string[] = []
  const restore = registerOpenHooks({
    afterSchemaApply: [() => calls.push('first'), () => calls.push('second')],
  })
  const fixture = new Database(':memory:')
  try {
    applySchemaForFixture(fixture)
    expect(calls).toEqual(['first', 'second'])
  } finally {
    fixture.close()
    restore()
  }
})
