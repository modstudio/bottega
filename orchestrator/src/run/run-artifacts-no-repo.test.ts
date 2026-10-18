import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { noRepoIsolatePath } from './run-artifacts.ts'

describe('review-lens-inline has no checkout', () => {
  test('the no-repo isolate is deterministically named below an owned runs directory', () => {
    const ownedRuns = '/var/lib/orch/runs'
    const runId = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    const recordId = db()
      .query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?')
      .get(runId)!.record_id
    expect(noRepoIsolatePath(runId, ownedRuns)).toBe(`/var/lib/orch/runs/isolates/${recordId}`)
    expect(noRepoIsolatePath(runId, ownedRuns).startsWith(tmpdir())).toBe(false)
  })
})
