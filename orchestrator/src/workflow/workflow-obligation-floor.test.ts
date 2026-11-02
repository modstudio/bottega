import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { floorFromObligationRow, openWorkflowObligations } from './workflow-obligation-floor.ts'

const CURSOR_ID = '00000000-0000-4000-8000-000000000021'
const OBLIGATION_ID = '00000000-0000-4000-8000-000000000022'

const database = testDatabaseFixture((d) => {
  d.query(
    `INSERT INTO project (record_id,name,path,stack,settings)
     VALUES ('00000000-0000-4000-8000-000000000020','fixture','/fixture','bun','{}')`,
  ).run()
  d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
       question,total_steps,created_at,updated_at,enforcement)
     VALUES (?,1,'fixture','flow','default','DEV-2015','','session',?,?,'{}',0,'acceptance',
             'running','[]',NULL,1,'2026-11-01','2026-11-01','floors')`,
  ).run(CURSOR_ID, workflowVersionRecordId(d), catalogueVersionRecordId(d))
})

test('open obligations round-trip every persisted floor field', () => {
  const d = database()
  d.query(
    `INSERT INTO workflow_obligation
      (record_id,cursor_record_id,step_ordinal,step_slug,floor,require_pull_request,
       operator_ruling,expected_exit_code,expected_status,floor_deferrable,reason,created_at)
     VALUES (?, ?, 1, 'acceptance', 'command-exit', 1, 1, 17, 'verified', 0,
             'round trip', '2026-11-01')`,
  ).run(OBLIGATION_ID, CURSOR_ID)

  expect(openWorkflowObligations(CURSOR_ID, d)).toEqual([
    {
      id: OBLIGATION_ID,
      stepOrdinal: 1,
      stepSlug: 'acceptance',
      floorDefinition: {
        kind: 'command-exit',
        deferrable: false,
        expectedExitCode: 17,
        expectedStatus: 'verified',
        requirePullRequest: true,
        operatorRuling: true,
      },
    },
  ])
})

test('an unknown obligation floor names the obligation and recovery', () => {
  expect(() =>
    floorFromObligationRow(
      {
        id: OBLIGATION_ID,
        floor: 'future-floor',
        require_pull_request: 0,
        operator_ruling: 0,
        expected_exit_code: 0,
        expected_status: 'done',
        floor_deferrable: 0,
      },
      CURSOR_ID,
    ),
  ).toThrow(
    `obligation ${OBLIGATION_ID} has unknown floor kind "future-floor"; this ${PLATFORM_NAME} binary does not know that floor kind; run \`${PLATFORM_SLUG} machine update\` when a newer ${PLATFORM_NAME} recorded the obligation, otherwise abandon its cursor with \`${PLATFORM_SLUG} workflow abandon --cursor ${CURSOR_ID}\``,
  )
})
