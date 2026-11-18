import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { CURSOR_RECORD_ID, database, identity } from './workflow-floor-evidence.fixture.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence-gather.ts'

test('satisfy evidence follows a handoff lineage only to its successor', async () => {
  const d = database()
  const source = newRecordId()
  const unrelated = newRecordId()
  d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     SELECT ?,number+1,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,'done',closed,question,
       total_steps,created_at,updated_at,enforcement
     FROM workflow_cursor WHERE record_id=?`,
  ).run(source, CURSOR_RECORD_ID)
  d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     SELECT ?,number+2,project,'unrelated-flow',mode_slug,'DEV-UNRELATED',instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,'running',closed,question,
       total_steps,created_at,updated_at,enforcement
     FROM workflow_cursor WHERE record_id=?`,
  ).run(unrelated, CURSOR_RECORD_ID)
  d.query('UPDATE workflow_cursor SET handed_off_from_record_id=? WHERE record_id=?').run(
    source,
    CURSOR_RECORD_ID,
  )
  const obligation = newRecordId()
  d.query(
    `INSERT INTO workflow_obligation
      (record_id,cursor_record_id,step_ordinal,step_slug,floor,floor_deferrable,reason,created_at)
     VALUES (?, ?, 1, 'rebase', 'recorded-artifact', 0, 'source evidence', '2026-09-01')`,
  ).run(obligation, source)
  const gatherFor = (cursorId: string) =>
    gatherValidatedEvidence({
      cursorId,
      cursorState: 'running',
      identity: { ...identity, worktree: null },
      stepOrdinal: 1,
      stepSlug: 'rebase',
      floors: [],
      evidence: { satisfies: obligation },
      d,
    })

  expect((await gatherFor(CURSOR_RECORD_ID)).satisfy).toMatchObject({
    found: true,
    open: true,
    cursorMatches: true,
  })
  expect((await gatherFor(unrelated)).satisfy).toMatchObject({
    found: true,
    open: true,
    cursorMatches: false,
  })
})
