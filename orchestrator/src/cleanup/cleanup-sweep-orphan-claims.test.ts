import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { orphanClaimRuling } from './cleanup-sweep-orphan-claims.ts'

test('orphan ruling reads claimed claims and current run pointers from the store', () => {
  const claimRun = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const pointerRun = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const claimedPath = join(dir, `claim-only-${claimRun}`)
  const pointerPath = join(dir, `pointer-only-${pointerRun}`)
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at,settled_at)
       VALUES (?,?,?,?, 'worktree', ?,NULL,NULL,'claimed',?,NULL)`,
    )
    .run(newRecordId(), claimRun, claimRun, null, claimedPath, nowIso())
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(pointerPath, pointerRun)

  expect(orphanClaimRuling(claimedPath, 0, false)).toMatchObject({
    action: 'claimed',
    keepLine: `claimed by run(s) ${claimRun} — kept`,
  })
  expect(orphanClaimRuling(pointerPath, 0, false)).toMatchObject({
    action: 'claimed',
    keepLine: `claimed by run(s) ${pointerRun} — kept`,
  })
})
