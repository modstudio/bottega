import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  acquireRunLease,
  heldRunCloseOutLeaseIds,
  heldRunLeaseIds,
  removeFreeRunCloseOutLease,
  removeFreeRunLease,
  runCloseOutLeaseIds,
  runCloseOutLeaseState,
  withRunCloseOutLease,
} from './run-lease.ts'

test('withRunCloseOutLease encloses async run-lease release and cleans up on every exit', async () => {
  const runId = addRun({ agent: 'codex', job: 'lease-release', status: 'ok' })
  const thrown = new Error('close-out action failed')

  try {
    for (const actionError of [null, thrown]) {
      const runLease = acquireRunLease(runId)
      let settleAction!: () => void
      const actionSettled = new Promise<void>((resolve) => {
        settleAction = resolve
      })
      const enclosed = withRunCloseOutLease(
        runId,
        () => {},
        async () => {
          expect(heldRunLeaseIds()).toContain(runId)
          expect(heldRunCloseOutLeaseIds()).toContain(runId)

          runLease.release()
          expect(heldRunLeaseIds()).not.toContain(runId)
          expect(heldRunCloseOutLeaseIds()).toContain(runId)

          await actionSettled
          if (actionError) throw actionError
        },
      )

      expect(heldRunCloseOutLeaseIds()).toContain(runId)
      settleAction()
      if (actionError) await expect(enclosed).rejects.toThrow(actionError)
      else await enclosed
      expect(heldRunCloseOutLeaseIds()).not.toContain(runId)
      expect(runCloseOutLeaseIds()).not.toContain(runId)
    }
  } finally {
    removeFreeRunLease(runId)
    db().query('DELETE FROM run WHERE record_id=?').run(runId)
  }
})

test('a second close-out lease acquisition in this process refuses without blocking', () => {
  const runId = addRun({ agent: 'codex', job: 'lease-second-acquire', status: 'ok' })
  let releaseFirst!: () => void
  const firstSettled = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const first = withRunCloseOutLease(
    runId,
    () => {},
    () => firstSettled,
  )
  let failure: unknown
  try {
    expect(() =>
      withRunCloseOutLease(
        runId,
        (cause) => {
          failure = cause
        },
        () => undefined,
      ),
    ).toThrow(/lock is already held/)
    expect(String(failure)).toContain('lock is already held')
  } finally {
    releaseFirst()
  }
  return first.finally(() => {
    removeFreeRunCloseOutLease(runId)
    db().query('DELETE FROM run WHERE record_id=?').run(runId)
  })
})

test('runCloseOutLeaseState reports held while the lease file exists and free after release', () => {
  const runId = addRun({ agent: 'codex', job: 'lease-state', status: 'ok' })
  let releaseHeld!: () => void
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  const enclosed = withRunCloseOutLease(
    runId,
    () => {},
    () => held,
  )
  try {
    expect(runCloseOutLeaseState(runId)).toBe('held')
    expect(runCloseOutLeaseIds()).toContain(runId)
  } finally {
    releaseHeld()
  }
  return enclosed.finally(() => {
    expect(runCloseOutLeaseState(runId)).toBe('missing')
    removeFreeRunCloseOutLease(runId)
    db().query('DELETE FROM run WHERE record_id=?').run(runId)
  })
})
