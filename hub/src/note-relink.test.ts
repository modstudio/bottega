import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { createNote, getNote, promoteNote, relinkNote } from './note.ts'
import { createLocalTaskInTransaction } from './task.ts'

const workshop = declareFixtureProjectSpace('workshop', 'workshop')
const previousHostedUrl = process.env.BOTTEGA_HOSTED_URL

beforeAll(() => {
  delete process.env.BOTTEGA_HOSTED_URL
})
beforeEach(resetFixtureStore)
beforeEach(() => void delete workshop().settings.space)
afterAll(() => {
  workshop().settings.space = 'workshop'
  if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
  else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
  resetFixtureStore()
})

test('relink rolls back the attachment when its history comment cannot be written', async () => {
  const note = (
    await createNote({
      text: `Relink rollback ${crypto.randomUUID()}`,
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    })
  ).note
  const [previous, target] = writeTransaction((conn) => [
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Rollback previous task' },
      { skipDuplicateCheck: true },
    ),
    createLocalTaskInTransaction(
      conn,
      { project: 'workshop', title: 'Rollback target task' },
      { skipDuplicateCheck: true },
    ),
  ])
  await promoteNote(note.record_id, { existingTaskKey: previous.key })
  writeTransaction((conn) =>
    conn.exec(`
      CREATE TEMP TRIGGER fail_relink_comment
      BEFORE INSERT ON task_comment
      BEGIN
        SELECT RAISE(ABORT, 'forced comment failure');
      END
    `),
  )
  try {
    await expect(relinkNote(note.record_id, target.key, 'must remain atomic')).rejects.toThrow(
      'forced comment failure',
    )
  } finally {
    writeTransaction((conn) => conn.exec('DROP TRIGGER fail_relink_comment'))
  }

  expect(getNote(note.record_id).promoted_task).toBe(previous.key)
  expect(
    db()
      .query<{ promoted_task_record_id: string }, [string]>(
        'SELECT promoted_task_record_id FROM note WHERE record_id=?',
      )
      .get(note.record_id),
  ).toEqual({ promoted_task_record_id: previous.record_id })
})
