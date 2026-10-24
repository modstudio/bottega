import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  acquireRunCloseOutLease,
  acquireRunLease,
  heldRunCloseOutLeaseIds,
  heldRunLeaseIds,
  releaseRunCloseOutLease,
  removeFreeRunLease,
  runCloseOutLeaseIds,
} from './run-lease.ts'

test('the close-out lease encloses run-lease release and is removed on every exit', () => {
  const runId = addRun({ agent: 'codex', job: 'lease-release', status: 'ok' })
  const thrown = new Error('close-out action failed')

  try {
    for (const actionError of [null, thrown]) {
      const runLease = acquireRunLease(runId)
      const closeOutLease = acquireRunCloseOutLease(runId)
      const enclosingRelease = () => {
        try {
          expect(heldRunLeaseIds()).toContain(runId)
          expect(heldRunCloseOutLeaseIds()).toContain(runId)

          runLease.release()
          expect(heldRunLeaseIds()).not.toContain(runId)
          expect(heldRunCloseOutLeaseIds()).toContain(runId)

          if (actionError) throw actionError
        } finally {
          releaseRunCloseOutLease(runId, closeOutLease)
        }
      }

      if (actionError) expect(enclosingRelease).toThrow(actionError)
      else enclosingRelease()
      expect(heldRunCloseOutLeaseIds()).not.toContain(runId)
      expect(runCloseOutLeaseIds()).not.toContain(runId)
    }
  } finally {
    removeFreeRunLease(runId)
    db().query('DELETE FROM run WHERE record_id=?').run(runId)
  }
})
