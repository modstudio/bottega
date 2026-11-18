import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { recordApiClient } from '../src/record/record-api-client.ts'
import { testRecordAuth } from './fixtures/record-auth-postgres.ts'

export function registerTaskFlowHandoffProof(
  input: {
    urls(): { actor: string; auth: string }
    spaceId(): string
    projectId(): string
    signIn(): void
    admin(statement: string): string
  },
  project: string,
  workflow: string,
): void {
  test('hosted handoff closes and opens atomically and refuses a foreign session', async () => {
    const auth = testRecordAuth(input.urls().actor, input.urls().auth)
    const proofProject = 'handoff-proof-project'
    const projectId = newRecordId(),
      machineId = newRecordId(),
      taskId = newRecordId(),
      flowId = newRecordId()
    const sourceId = newRecordId(),
      successorId = newRecordId(),
      at = new Date().toISOString()
    try {
      input.admin(`
        INSERT INTO project(id,space_id,name,created_at)
        VALUES ('${projectId}','${input.spaceId()}','${proofProject}',now());
        INSERT INTO machine(id,user_id,name,registered_at,last_seen)
        VALUES ('${machineId}',(SELECT user_id FROM membership WHERE space_id='${input.spaceId()}' LIMIT 1),'handoff-proof',now(),now());
        INSERT INTO hub_task(id,space_id,project_name,project_id,key,project,title,status,status_category,source,first_seen,last_seen,created_at,updated_at)
        VALUES ('${taskId}','${input.spaceId()}','${proofProject}','${projectId}','AA-2412','${proofProject}','handoff proof','active','active','local',now(),now(),now(),now());`)
      input.signIn()
      const client = recordApiClient()
      const destination = { destinationSpaceId: input.spaceId() }
      await client.ensureSpaceBuiltIns!(destination)
      const workflowVersionId = input.admin(
        `SELECT version.id FROM workflow_version version JOIN workflow ON workflow.id=version.workflow_id WHERE workflow.space_id='${input.spaceId()}' AND workflow.slug='${workflow}' ORDER BY version.n DESC LIMIT 1;`,
      )
      const catalogueVersionId = input.admin(
        `SELECT version.id FROM step_catalogue_version version JOIN step_catalogue catalogue ON catalogue.id=version.catalogue_id WHERE catalogue.space_id='${input.spaceId()}' AND catalogue.slug='shared' ORDER BY version.n DESC LIMIT 1;`,
      )
      const stage = {
        id: sourceId,
        flowRecordId: flowId,
        projectId,
        workflow,
        mode: 'default',
        workflowKey: 'AA-2412',
        instanceId: '',
        sessionId: 'handoff-owner',
        workflowVersionId,
        catalogueVersionId,
        arguments: { key: 'AA-2412' },
        activeOrdinal: 1,
        activeSlug: 'implement',
        state: 'running' as const,
        closedStepNotes: [],
        question: null,
        autonomy: null,
        enforcement: 'floors',
        totalSteps: 3,
        openedMachineId: machineId,
        takenOverFromMachineId: null,
        lastAdvancedMachineId: machineId,
        createdAt: at,
        updatedAt: at,
      }
      await client.composeTaskFlow!(
        {
          requestId: newRecordId(),
          flowInsert: {
            id: flowId,
            projectId,
            taskId,
            state: 'open',
            openStageRecordId: sourceId,
            openingMachineId: machineId,
            updatedMachineId: machineId,
            createdAt: at,
            updatedAt: at,
          },
          stageInsert: stage,
        },
        destination,
      )
      input.admin(
        `INSERT INTO context_item(id,space_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at) VALUES ('${newRecordId()}','${input.spaceId()}','cursor','${sourceId}','proof','fact','moves','proof',now(),now());`,
      )
      const payload = (sessionId: string, openStageRecordId = successorId) => ({
        requestId: newRecordId(),
        flow: {
          id: flowId,
          expectedRevision: 1,
          values: { openStageRecordId, updatedMachineId: machineId, updatedAt: at },
        },
        oldStage: { id: sourceId, expectedRevision: 1 },
        newStage: {
          ...stage,
          id: successorId,
          sessionId,
          handedOffFromRecordId: sourceId,
          activeOrdinal: 0,
          activeSlug: 'diagnose',
          closedStepNotes: [],
        },
        trail: {
          closed: [],
          current: { n: 2, slug: 'implement' },
          remaining: [{ n: 3, slug: 'complete' }],
          targetWorkflow: workflow,
          reason: 'ready',
          at,
        },
      })
      await expect(
        client.handoffTaskFlow!(payload('handoff-owner', newRecordId()), destination),
      ).rejects.toThrow('retry with the successor stage as the open stage')
      expect(
        input.admin(`SELECT state || '|' || revision FROM task_flow_stage WHERE id='${sourceId}';`),
      ).toBe('running|1')
      expect(input.admin(`SELECT count(*) FROM task_flow_stage WHERE id='${successorId}';`)).toBe(
        '0',
      )
      await expect(
        client.handoffTaskFlow!(payload('foreign-session'), destination),
      ).rejects.toThrow('owned by another session')
      input.admin(
        `CREATE OR REPLACE FUNCTION fail_handoff_context() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced handoff failure'; END $$; CREATE TRIGGER fail_handoff_context BEFORE UPDATE ON context_item FOR EACH ROW EXECUTE FUNCTION fail_handoff_context();`,
      )
      await expect(client.handoffTaskFlow!(payload('handoff-owner'), destination)).rejects.toThrow(
        'record API 500',
      )
      expect(
        input.admin(`SELECT state || '|' || revision FROM task_flow_stage WHERE id='${sourceId}';`),
      ).toBe('running|1')
      expect(input.admin(`SELECT count(*) FROM task_flow_stage WHERE id='${successorId}';`)).toBe(
        '0',
      )
      input.admin(
        'DROP TRIGGER fail_handoff_context ON context_item; DROP FUNCTION fail_handoff_context();',
      )
      const handed = await client.handoffTaskFlow!(payload('handoff-owner'), destination)
      expect(handed.stage.id).toBe(successorId)
      expect(input.admin(`SELECT state FROM task_flow_stage WHERE id='${sourceId}';`)).toBe('done')
      expect(input.admin(`SELECT open_stage_record_id FROM task_flow WHERE id='${flowId}';`)).toBe(
        successorId,
      )
      expect(
        input.admin(
          `SELECT holder_id FROM context_item WHERE slug='proof' AND space_id='${input.spaceId()}';`,
        ),
      ).toBe(successorId)
      const claim = await client.takeBoardClaim!(
        {
          id: newRecordId(),
          project: proofProject,
          projectId,
          subject: 'task:AA-2412',
          holderSession: 'handoff-owner',
        },
        destination,
      )
      expect(claim.action).toBe('taken')
      await expect(
        client.takeBoardClaim!(
          {
            id: newRecordId(),
            project: proofProject,
            projectId,
            subject: 'task:AA-2412',
            holderSession: 'foreign-session',
          },
          destination,
        ),
      ).rejects.toThrow(
        'task claims follow task cursors; run workflow compose … --arg key=AA-2412 instead',
      )
    } finally {
      input.admin(
        'DROP TRIGGER IF EXISTS fail_handoff_context ON context_item; DROP FUNCTION IF EXISTS fail_handoff_context();',
      )
      await auth.close()
    }
  })
}
