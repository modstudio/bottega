import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { writeTransaction } from './db.ts'
import { afterWriteCommit } from './write-commit-effects.ts'

test('a keyed effect is queued once without suppressing unkeyed effects', () => {
  const database = new Database(':memory:')
  const observations: string[] = []

  writeTransaction(() => {
    afterWriteCommit(database, () => observations.push('keyed-first'), 'shared-key')
    afterWriteCommit(database, () => observations.push('keyed-second'), 'shared-key')
    afterWriteCommit(database, () => observations.push('unkeyed'))
    afterWriteCommit(database, () => observations.push('keyed-third'), 'shared-key')
    expect(observations).toEqual([])
  }, database)

  expect(observations).toEqual(['keyed-first', 'unkeyed'])
  database.close()
})
