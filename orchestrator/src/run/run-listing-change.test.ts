import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { collectChangeCursor } from './collect-change.ts'
import { applyChangedAfterFilter } from './run-listing.ts'

async function changedRoots(after: number): Promise<string[]> {
  const where = ['r.parent_run_record_id IS NULL']
  const args: Array<string | number> = []
  await applyChangedAfterFilter(after, where, args)
  return db()
    .query<{ record_id: string }, Array<string | number>>(
      `SELECT r.record_id FROM run r WHERE ${where.join(' AND ')}`,
    )
    .all(...args)
    .map((row) => row.record_id)
}

test('changed-after selects a mutation once and does not republish an open question', async () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const beforeQuestion = collectChangeCursor()
  db()
    .query(
      `INSERT INTO question(number,record_id,run_record_id,asked_at,question)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,?)`,
    )
    .run(newRecordId(), id, '2026-11-03T12:00:00.000Z', 'Still open?')
  expect(await changedRoots(beforeQuestion)).toContain(id)
  const afterQuestion = collectChangeCursor()
  expect(await changedRoots(afterQuestion)).toEqual([])
  db()
    .query(
      "UPDATE question SET answer='Yes',answered_at='2026-11-03T12:01:00.000Z' WHERE run_record_id=?",
    )
    .run(id)
  expect(await changedRoots(afterQuestion)).toContain(id)
  expect(await changedRoots(collectChangeCursor())).toEqual([])
})
