import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { settleCreateTimeBranchCleanup } from './create-time-settlement.ts'

function claimedBranch(runId: number): number {
  return Number(
    db()
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,kind,allocation_key,state,claimed_at)
         VALUES (?,?,'branch','refs/heads/DEV-991','claimed',?)`,
      )
      .run(runId, runId, nowIso()).lastInsertRowid,
  )
}

test('create-time cleanup releases a deleted branch claim', () => {
  const runId = addRun({ agent: 'codex', job: 'implement' })
  const claimId = claimedBranch(runId)
  settleCreateTimeBranchCleanup(
    { path: '/tree', repoRoot: '/repo', branch: 'DEV-991', base: 'base', mintedBranch: 'DEV-991' },
    runId,
    { database: db(), observeRef: () => ({ outcome: 'absent' }) },
  )
  expect(db().query('SELECT state FROM resource_claim WHERE id=?').get(claimId)).toEqual({
    state: 'released',
  })
})

test('create-time cleanup leaves a surviving branch claimed', () => {
  const runId = addRun({ agent: 'codex', job: 'implement' })
  const claimId = claimedBranch(runId)
  settleCreateTimeBranchCleanup(
    { path: '/tree', repoRoot: '/repo', branch: 'DEV-991', base: 'base', mintedBranch: 'DEV-991' },
    runId,
    { database: db(), observeRef: () => ({ outcome: 'present' }) },
  )
  expect(db().query('SELECT state FROM resource_claim WHERE id=?').get(claimId)).toEqual({
    state: 'claimed',
  })
})
