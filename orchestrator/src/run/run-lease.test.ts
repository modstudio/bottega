import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  acquireRunLease,
  heldRunCloseOutLeaseIds,
  heldRunLeaseIds,
  releaseRunCloseOutLease,
  removeFreeRunCloseOutLease,
  removeFreeRunLease,
  requiredRunCloseOutLease,
  runCloseOutLeaseIds,
  runCloseOutLeaseState,
  withRunCloseOutLease,
} from './run-lease.ts'

test('withRunCloseOutLease encloses synchronous run-lease release and cleans up on every exit', () => {
  const runId = addRun({ agent: 'codex', job: 'lease-release', status: 'ok' })
  const thrown = new Error('close-out action failed')

  try {
    for (const actionError of [null, thrown]) {
      const runLease = acquireRunLease(runId)
      const invoke = () =>
        withRunCloseOutLease(
          runId,
          () => {},
          () => {
            expect(heldRunLeaseIds()).toContain(runId)
            expect(heldRunCloseOutLeaseIds()).toContain(runId)

            runLease.release()
            expect(heldRunLeaseIds()).not.toContain(runId)
            expect(heldRunCloseOutLeaseIds()).toContain(runId)

            if (actionError) throw actionError
          },
        )
      if (actionError) expect(invoke).toThrow(actionError)
      else invoke()
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
  const first = requiredRunCloseOutLease(runId, () => {})
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
    releaseRunCloseOutLease(runId, first)
    removeFreeRunCloseOutLease(runId)
    db().query('DELETE FROM run WHERE record_id=?').run(runId)
  }
})

test('runCloseOutLeaseState reports held while the lease file exists and free after release', () => {
  const runId = addRun({ agent: 'codex', job: 'lease-state', status: 'ok' })
  try {
    withRunCloseOutLease(
      runId,
      () => {},
      () => {
        expect(runCloseOutLeaseState(runId)).toBe('held')
        expect(runCloseOutLeaseIds()).toContain(runId)
      },
    )
    expect(runCloseOutLeaseState(runId)).toBe('missing')
  } finally {
    removeFreeRunCloseOutLease(runId)
    db().query('DELETE FROM run WHERE record_id=?').run(runId)
  }
})
