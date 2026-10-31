import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { heldRunCloseOutLeaseIds, withRunCloseOutLease } from '../run/run-lease.ts'
import { closeOutRun } from './close-out.ts'
import { withCloseOutLease } from './close-out-lease.ts'

test('a sweep close-out runs its work under the close-out lease', () => {
  const runId = addRun({ agent: 'codex', job: 'sweep-close-out-lease', status: 'ok' })
  const held = withCloseOutLease(runId, false, () => heldRunCloseOutLeaseIds().includes(runId))
  expect(held).toBe(true)
  expect(heldRunCloseOutLeaseIds()).not.toContain(runId)
})

test('a refused turn close-out lease carries the contested turn identity beside its root', () => {
  const rootId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const turnId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: rootId,
    turn: 2,
  })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run('/held-turn-tree', rootId)
  const turn = db().query('SELECT number FROM run WHERE record_id=?').get(turnId) as {
    number: number
  }

  withRunCloseOutLease(
    turnId,
    () => {},
    () => {
      expect(withCloseOutLease(turnId, false, () => true)).toMatchObject({
        runId: rootId,
        worktree: '/held-turn-tree',
        outcome: 'held',
        hold: 'close-out-lease',
        leaseHolder: { runId: turnId, number: turn.number, job: 'implement' },
      })
    },
  )
})

test('the coordinator still closes out under the close-out lease it already holds', () => {
  const runId = addRun({ agent: 'codex', job: 'coordinator-close-out-lease', status: 'ok' })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run('/missing-coordinator-tree', runId)
  withRunCloseOutLease(
    runId,
    () => {},
    () => {
      expect(closeOutRun(runId, { intent: 'terminal' })).toMatchObject({
        outcome: 'held',
        hold: 'close-out-lease',
      })
      expect(closeOutRun(runId, { intent: 'terminal', closeOutLeaseHeld: true }).outcome).toBe(
        'absent',
      )
    },
  )
})
