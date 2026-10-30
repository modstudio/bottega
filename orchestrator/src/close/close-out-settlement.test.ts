import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { closeOutRun } from './close-out.ts'

test('worktree settlement records the close-out caller', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const worktree = join(dir, 'absent-close-out-caller-tree')
  const claimRecordId = newRecordId()
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(worktree, runId)
  db()
    .query(
      `INSERT INTO resource_claim
        (record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,?,'worktree',?,'claimed','2026-10-30')`,
    )
    .run(claimRecordId, runId, runId, worktree)

  closeOutRun(runId, { intent: 'explicit' })
  const caller = `close-out intent=explicit pid=${process.pid} ppid=${process.ppid}`
  const run = db()
    .query('SELECT close_out_detail detail FROM run WHERE record_id=?')
    .get(runId) as {
    detail: string
  }
  const claim = db()
    .query('SELECT settled_detail detail FROM resource_claim WHERE record_id=?')
    .get(claimRecordId) as { detail: string }
  expect(run.detail).toContain(caller)
  expect(claim.detail).toContain(caller)
})
