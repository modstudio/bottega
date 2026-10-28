import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import * as closeOut from './close-out.ts'
import { releaseStoppedReaderClone } from './close-out-stop-release.ts'
import { cleanFixture, closeOutFixture } from './reader-scratch-close-out.fixture.ts'

afterEach(() => {
  mock.restore()
})

test('a writing job is not applicable and its tree is left in place', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run('/tmp/writer-tree', id)

  expect(releaseStoppedReaderClone(id)).toEqual({ outcome: 'not-applicable', detail: null })
  expect(
    db().query('SELECT worktree, close_out_outcome FROM run WHERE record_id=?').get(id),
  ).toEqual({ worktree: '/tmp/writer-tree', close_out_outcome: null })
})

test('a reader clone is released and the pointer is cleared', () => {
  const fixture = closeOutFixture()
  db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(fixture.id)
  try {
    expect(releaseStoppedReaderClone(fixture.id)).toEqual({
      outcome: 'released',
      detail: expect.any(String),
    })
    expect(
      db().query('SELECT worktree, close_out_outcome FROM run WHERE record_id=?').get(fixture.id),
    ).toEqual({ worktree: null, close_out_outcome: 'released' })
    expect(existsSync(fixture.worktree)).toBe(false)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('a thrown close-out that still recorded a release is released', () => {
  const fixture = closeOutFixture()
  db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(fixture.id)
  spyOn(closeOut, 'closeOutRun').mockImplementation((runId: string) => {
    db()
      .query(
        `UPDATE run SET worktree=NULL, close_out_outcome='released',
           close_out_detail='released after throw' WHERE record_id=?`,
      )
      .run(runId)
    throw new Error('close-out threw after recording')
  })
  try {
    expect(releaseStoppedReaderClone(fixture.id)).toEqual({
      outcome: 'released',
      detail: 'close-out threw after recording',
    })
    expect(db().query('SELECT worktree FROM run WHERE record_id=?').get(fixture.id)).toEqual({
      worktree: null,
    })
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('a thrown close-out that did not record a release is kept', () => {
  const fixture = closeOutFixture()
  db().query("UPDATE run SET status='stopped' WHERE record_id=?").run(fixture.id)
  spyOn(closeOut, 'closeOutRun').mockImplementation(() => {
    throw new Error('close-out threw before recording')
  })
  try {
    expect(releaseStoppedReaderClone(fixture.id)).toEqual({
      outcome: 'kept',
      detail: 'close-out threw before recording',
    })
    expect(
      db().query('SELECT worktree, close_out_outcome FROM run WHERE record_id=?').get(fixture.id),
    ).toEqual({ worktree: fixture.worktree, close_out_outcome: null })
    expect(existsSync(fixture.worktree)).toBe(true)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
