import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import {
  beginResourceStep,
  completeResourceStep,
  recordResourceStep,
  recordResourceStepAsync,
} from './resource-step-recorder.ts'

function input(rootRunId: string, allocationKey: string, shared = false) {
  return {
    rootRunId,
    runId: rootRunId,
    projectId: null,
    kind: 'worktree' as const,
    allocationKey,
    identity: allocationKey,
    label: rootRunId,
    claimedAt: nowIso(),
    shared,
  }
}

test('resource steps are pending before effects and complete in root order', () => {
  const root = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  const observed: unknown[] = []
  recordResourceStep(db(), input(root, '/tmp/first'), () => {
    observed.push(
      db().query('SELECT state,step_no FROM resource_claim WHERE root_run_record_id=?').get(root),
    )
  })
  recordResourceStep(db(), input(root, '/tmp/second'), () => undefined)

  expect(observed).toEqual([{ state: 'pending', step_no: 1 }])
  expect(
    db()
      .query(
        'SELECT allocation_key,state,step_no FROM resource_claim WHERE root_run_record_id=? ORDER BY step_no',
      )
      .all(root),
  ).toEqual([
    { allocation_key: '/tmp/first', state: 'claimed', step_no: 1 },
    { allocation_key: '/tmp/second', state: 'claimed', step_no: 2 },
  ])
})

test('a failed effect leaves its ordered row pending', () => {
  const root = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  expect(() =>
    recordResourceStep(db(), input(root, '/tmp/fails'), () => {
      throw new Error('effect failed')
    }),
  ).toThrow('effect failed')
  expect(
    db().query('SELECT state,step_no FROM resource_claim WHERE root_run_record_id=?').get(root),
  ).toEqual({ state: 'pending', step_no: 1 })
})

test('a rejected async effect leaves its ordered row pending', async () => {
  const root = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  await expect(
    recordResourceStepAsync(db(), input(root, '/tmp/async-fails'), async () => {
      throw new Error('async effect failed')
    }),
  ).rejects.toThrow('async effect failed')
  expect(
    db().query('SELECT state,step_no FROM resource_claim WHERE root_run_record_id=?').get(root),
  ).toEqual({ state: 'pending', step_no: 1 })
})

test('a repeated same-root completion settles as a duplicate of the live row', () => {
  const root = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  recordResourceStep(db(), input(root, '/tmp/repeated'), () => undefined)
  recordResourceStep(db(), input(root, '/tmp/repeated'), () => undefined)
  const rows = db()
    .query(
      `SELECT record_id,state,settled_detail FROM resource_claim
       WHERE root_run_record_id=? ORDER BY step_no`,
    )
    .all(root) as Array<{ record_id: string; state: string; settled_detail: string | null }>
  expect(rows[0]!.state).toBe('claimed')
  expect(rows[1]).toEqual({
    record_id: rows[1]!.record_id,
    state: 'absent',
    settled_detail: `duplicate of existing resource claim ${rows[0]!.record_id}`,
  })
})

test('shared claims coexist while a second unshared completion collides', () => {
  const first = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const second = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const key = '/tmp/shared-reader'
  const firstShared = beginResourceStep(db(), input(first, key, true))
  const secondShared = beginResourceStep(db(), input(second, key, true))
  completeResourceStep(db(), firstShared)
  completeResourceStep(db(), secondShared)
  expect(
    db().query("SELECT COUNT(*) count FROM resource_claim WHERE state='claimed'").get(),
  ).toEqual({ count: 2 })

  const unshared = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  completeResourceStep(db(), beginResourceStep(db(), input(unshared, '/tmp/exclusive')))
  const colliding = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  const pending = beginResourceStep(db(), input(colliding, '/tmp/exclusive'))
  expect(() => completeResourceStep(db(), pending)).toThrow(/already claimed by/)
  expect(
    db().query('SELECT state FROM resource_claim WHERE record_id=?').get(pending.recordId),
  ).toEqual({
    state: 'pending',
  })
})

test('an existing shared row is skipped by an unshared collision check', () => {
  const shared = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
  const unshared = addRun({ agent: 'codex', job: 'understand', status: 'running' })
  const key = '/tmp/shared-does-not-collide'
  recordResourceStep(db(), input(shared, key, true), () => undefined)
  recordResourceStep(db(), input(unshared, key), () => undefined)
  expect(
    db().query("SELECT COUNT(*) count FROM resource_claim WHERE state='claimed'").get(),
  ).toEqual({ count: 2 })
})
