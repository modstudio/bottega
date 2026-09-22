import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { releaseFailedLandingTree } from './tree.ts'

test('failed creation settles its worktree claim after the recipe already removed the directory', () => {
  const id = addRun({ agent: '(architect)', job: 'landing-tree', status: 'failed' })
  const missing = `/no-such-landing-tree-${id}`
  db().query('UPDATE run SET worktree=?, cwd=? WHERE id=?').run(missing, missing, id)
  db()
    .query(
      `INSERT INTO resource_claim
       (root_run_id,run_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,'worktree',?,'claimed',?)`,
    )
    .run(id, id, missing, '2026-09-22T00:00:00.000Z')

  releaseFailedLandingTree(id)

  expect(
    db().query("SELECT state FROM resource_claim WHERE root_run_id=? AND kind='worktree'").get(id),
  ).toEqual({ state: 'absent' })
})
