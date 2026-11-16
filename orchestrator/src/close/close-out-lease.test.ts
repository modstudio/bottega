import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  heldRunCloseOutLeaseIds,
  releaseRunCloseOutLease,
  requiredRunCloseOutLease,
} from '../run/run-lease.ts'
import { closeOutRunPrepared } from './close-out.ts'
import { withCloseOutLease } from './close-out-lease.ts'

test('a sweep close-out runs its work under the close-out lease', async () => {
  const runId = addRun({ agent: 'codex', job: 'sweep-close-out-lease', status: 'ok' })
  const held = await withCloseOutLease(runId, false, async () =>
    heldRunCloseOutLeaseIds().includes(runId),
  )
  expect(held).toBe(true)
  expect(heldRunCloseOutLeaseIds()).not.toContain(runId)
})

test('a refused turn close-out lease carries the contested turn identity beside its root', async () => {
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

  const lease = requiredRunCloseOutLease(turnId, () => {})
  try {
    expect(await withCloseOutLease(turnId, false, async () => true)).toMatchObject({
      runId: rootId,
      worktree: '/held-turn-tree',
      outcome: 'held',
      hold: 'close-out-lease',
      leaseHolder: { runId: turnId, number: turn.number, job: 'implement' },
    })
  } finally {
    releaseRunCloseOutLease(turnId, lease)
  }
})

test('the coordinator still closes out under the close-out lease it already holds', async () => {
  const runId = addRun({ agent: 'codex', job: 'coordinator-close-out-lease', status: 'ok' })
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run('/missing-coordinator-tree', runId)
  const lease = requiredRunCloseOutLease(runId, () => {})
  try {
    expect(
      await closeOutRunPrepared(runId, { intent: 'terminal' }, { cursorWorktrees: [] }),
    ).toMatchObject({
      outcome: 'held',
      hold: 'close-out-lease',
    })
    expect(
      (
        await closeOutRunPrepared(
          runId,
          { intent: 'terminal', closeOutLeaseHeld: true },
          { cursorWorktrees: [] },
        )
      ).outcome,
    ).toBe('absent')
  } finally {
    releaseRunCloseOutLease(runId, lease)
  }
})
