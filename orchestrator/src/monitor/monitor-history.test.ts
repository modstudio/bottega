import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { monitorWorktreeReleases } from './monitor-history.ts'

test('worktree release history includes settled claims and excludes unsettled claims', () => {
  const settledRun = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const claimedRun = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const pendingRun = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const stuckRun = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  const insert = db().query(
    `INSERT INTO resource_claim
     (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at,
      settled_at,settled_verb,settled_session,settled_detail)
     VALUES (?,?,?,'worktree',?,?,?,?,?,?,?)`,
  )
  insert.run(
    newRecordId(),
    settledRun,
    settledRun,
    '/tmp/released-tree',
    'released',
    nowIso(),
    nowIso(),
    'close-out:requested',
    'architect-session',
    'removed tree',
  )
  insert.run(
    newRecordId(),
    claimedRun,
    claimedRun,
    '/tmp/live-tree',
    'claimed',
    nowIso(),
    null,
    null,
    null,
    null,
  )
  insert.run(
    newRecordId(),
    pendingRun,
    pendingRun,
    '/tmp/pending-tree',
    'pending',
    nowIso(),
    null,
    null,
    null,
    null,
  )
  insert.run(
    newRecordId(),
    stuckRun,
    stuckRun,
    '/tmp/stuck-tree',
    'stuck',
    nowIso(),
    nowIso(),
    'resource-step-recorder:markResourceStepStuck',
    'architect-session',
    'creation failed',
  )

  expect(monitorWorktreeReleases()).toContainEqual({
    path: '/tmp/released-tree',
    run: settledRun,
    root_run: settledRun,
    state: 'released',
    settled_at: expect.any(String),
    verb: 'close-out:requested',
    session: 'architect-session',
    settled_detail: 'removed tree',
  })
  const paths = monitorWorktreeReleases().map((release) => release.path)
  expect(paths).not.toContain('/tmp/live-tree')
  expect(paths).not.toContain('/tmp/pending-tree')
  expect(paths).not.toContain('/tmp/stuck-tree')
})
