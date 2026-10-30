import { expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { cleanFixture, closeOutFixture } from '../close/reader-scratch-close-out.fixture.ts'
import { db, nowIso } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { recordCreatedWorktreeClaims } from '../resources/resource-claims.ts'
import {
  observeReaderTreeConditions,
  type ReaderTreeObservation,
  readerTreeHealthConditions,
} from './reader-tree-conditions.ts'

const reader: ReaderTreeObservation = {
  runId: '40000000-0000-4000-8000-000000000000',
  project: 'alpha',
  worktree: '/alpha/tree-a',
  commit: 'abc123',
  startedAt: '2026-10-30T10:00:00.000Z',
  live: true,
  confined: true,
  readOnly: true,
  dirty: false,
  dirtyDetail: 'clean',
  shared: true,
}

test('reader tree health reports dirty sharing and duplicate confined clones', () => {
  const conditions = readerTreeHealthConditions([
    reader,
    {
      ...reader,
      runId: '41000000-0000-4000-8000-000000000000',
      dirty: true,
      dirtyDetail: 'tracked path changed',
    },
    {
      ...reader,
      runId: '42000000-0000-4000-8000-000000000000',
      worktree: '/alpha/tree-b',
    },
  ])
  expect(conditions.map((condition) => condition.kind)).toEqual([
    'shared-reader-tree-dirty',
    'duplicate-reader-clone',
  ])
  expect(conditions[0]!.detail).toContain('41000000-0000-4000-8000-000000000000')
  expect(conditions[1]!.detail).toContain('/alpha/tree-b')
})

test('reader tree observation derives shared dirt and duplicate commits from stored claims', () => {
  const fixture = closeOutFixture()
  try {
    const database = db()
    const base = git(['rev-parse', 'HEAD'], fixture.worktree)
    const project = database
      .query('SELECT record_id FROM project WHERE path=?')
      .get(fixture.repo) as { record_id: string }
    database
      .query(
        `UPDATE run SET project_record_id=?,sandbox='srt',status='ok',base_commit='not-the-claim'
         WHERE record_id=?`,
      )
      .run(project.record_id, fixture.id)
    recordCreatedWorktreeClaims(database, {
      rootRunId: fixture.id,
      runId: fixture.id,
      projectId: project.record_id,
      owned: true,
      path: fixture.worktree,
      head: base,
      sharedReader: true,
      mintedBranch: null,
      label: fixture.id,
      claimedAt: nowIso(),
    })
    writeFileSync(join(fixture.worktree, 'tracked.txt'), 'escaped\n')

    const released = observeReaderTreeConditions(database)
    expect(released.errors).toEqual([])
    expect(released.conditions.map((condition) => condition.kind)).toContain(
      'shared-reader-tree-dirty',
    )

    database.query(`UPDATE run SET status='asking',pid=NULL WHERE record_id=?`).run(fixture.id)
    const live = observeReaderTreeConditions(database)
    expect(live.conditions.map((condition) => condition.kind)).not.toContain(
      'shared-reader-tree-dirty',
    )

    const secondRun = addRun({ agent: 'claude', job: 'review-lens', status: 'asking' })
    const secondTree = join(fixture.repo, '.claude', 'worktrees', 'monitor-second-reader')
    git(['clone', '--shared', fixture.repo, secondTree], fixture.repo)
    git(['checkout', '--detach', base], secondTree)
    database
      .query(
        `UPDATE run SET project_record_id=?,repo=?,cwd=?,worktree=?,sandbox='srt',pid=NULL,
         base_commit='also-not-the-claim',head_commit=? WHERE record_id=?`,
      )
      .run(project.record_id, 'monitor-reader-project', secondTree, secondTree, base, secondRun)
    recordCreatedWorktreeClaims(database, {
      rootRunId: secondRun,
      runId: secondRun,
      projectId: project.record_id,
      owned: true,
      path: secondTree,
      head: base,
      mintedBranch: null,
      label: secondRun,
      claimedAt: nowIso(),
    })

    const duplicated = observeReaderTreeConditions(database)
    expect(duplicated.errors).toEqual([])
    expect(duplicated.conditions).toContainEqual(
      expect.objectContaining({
        kind: 'duplicate-reader-clone',
        subject: expect.stringContaining(base),
      }),
    )
  } finally {
    mock.restore()
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
