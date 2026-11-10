import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { setMachineValue } from '../../shared/machine-config.ts'
import { newRecordId } from '../../shared/record-id.ts'
import { migratedTestDatabase } from '../src/database/test-database.fixture.ts'
import { rememberProjectSpace } from '../src/project-space.ts'
import { rememberHostedRecord } from '../src/record/install-binding-write.ts'
import { recordApiClient } from '../src/record/record-api-client.ts'
import { bearerHeaders, setActiveRecordSpaceForSession } from '../src/record/record-auth.ts'
import { pullRecordCache } from '../src/record/record-cache.ts'
import { syncRecord } from '../src/record/record-sync.ts'
import { readThroughTaskFlow } from '../src/workflow/task-flow-read-through.ts'
import { composeWorkflowWithCursor } from '../src/workflow/workflow-cursor.ts'
import {
  abandonCursor,
  selectAndNextWorkflowStep as nextWorkflowStep,
  testPorts,
} from '../src/workflow/workflow-cursor-test.fixture.ts'
import { seedWorkflows } from '../src/workflow/workflow-seeds.ts'
import { installWorkflowStoreFixture } from '../src/workflow/workflow-store.fixture.ts'
import { testRecordAuth } from './fixtures/record-auth-postgres.ts'

type Input = {
  urls(): { actor: string; auth: string }
  spaceId(): string
  projectId(): string
  token(): string
  signIn(): void
  admin(statement: string): string
}

const PROJECT = 'auth-a-project'
const WORKFLOW = 'fix-defect'
const TASK_KEY = 'AA-2098'
const DIRECT_TASK_KEY = 'AA-2234'

function proofDatabase(projectId: string): Database {
  const database = migratedTestDatabase()
  seedWorkflows(database)
  installWorkflowStoreFixture(database)
  database
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings)
       VALUES (?,?,?,'bun',?)`,
    )
    .run(
      projectId,
      PROJECT,
      '/tmp/hosted-task-flow-proof',
      JSON.stringify({
        trunk: 'main',
        gate: 'bun run check',
        docs: { protocol: 'orch-docs' },
        tracker: { protocol: 'hub' },
      }),
    )
  return database
}

export function registerTaskFlowReadThroughTakeoverProof(input: Input): void {
  test('hosted task-flow intents conflict, retry idempotently, and remain space isolated', async () => {
    const flowId = newRecordId()
    const stageId = newRecordId()
    const taskId = newRecordId()
    const machineId = newRecordId()
    const composeRequestId = newRecordId()
    const advanceRequestId = newRecordId()
    const obligationId = newRecordId()
    const at = new Date().toISOString()
    const auth = testRecordAuth(input.urls().actor, input.urls().auth)
    try {
      input.admin(`
        INSERT INTO machine(id,user_id,name,registered_at,last_seen)
        VALUES ('${machineId}',(SELECT user_id FROM membership WHERE space_id='${input.spaceId()}' LIMIT 1),
          'direct-task-flow-proof',now(),now());
        INSERT INTO hub_task
          (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
           first_seen,last_seen,created_at,updated_at)
        VALUES ('${taskId}','${input.spaceId()}','${PROJECT}','${input.projectId()}',
          '${DIRECT_TASK_KEY}','${PROJECT}','direct task-flow proof','active','active','local',
          now(),now(),now(),now());
      `)
      input.signIn()
      const client = recordApiClient()
      await client.ensureSpaceBuiltIns!({ destinationSpaceId: input.spaceId() })
      const workflowVersionId = input.admin(
        `SELECT version.id FROM workflow_version version JOIN workflow ON workflow.id=version.workflow_id
         WHERE workflow.space_id='${input.spaceId()}' AND workflow.slug='${WORKFLOW}' ORDER BY version.n DESC LIMIT 1;`,
      )
      const catalogueVersionId = input.admin(
        `SELECT version.id FROM step_catalogue_version version JOIN step_catalogue catalogue ON catalogue.id=version.catalogue_id
         WHERE catalogue.space_id='${input.spaceId()}' AND catalogue.slug='shared' ORDER BY version.n DESC LIMIT 1;`,
      )
      const flow = {
        id: flowId,
        projectId: input.projectId(),
        taskId,
        state: 'open' as const,
        openStageRecordId: stageId,
        openingMachineId: machineId,
        updatedMachineId: machineId,
        createdAt: at,
        updatedAt: at,
      }
      const stage = {
        id: stageId,
        flowRecordId: flowId,
        projectId: input.projectId(),
        workflow: WORKFLOW,
        mode: 'default',
        workflowKey: DIRECT_TASK_KEY,
        instanceId: '',
        sessionId: 'direct-client-a',
        workflowVersionId,
        catalogueVersionId,
        arguments: { key: DIRECT_TASK_KEY, mode: 'proof' },
        activeOrdinal: 0,
        activeSlug: 'diagnose',
        state: 'running' as const,
        closedStepNotes: [],
        question: null,
        autonomy: null,
        enforcement: 'note-only',
        totalSteps: 3,
        openedMachineId: machineId,
        takenOverFromMachineId: null,
        lastAdvancedMachineId: machineId,
        createdAt: at,
        updatedAt: at,
      }
      expect(
        await client.composeTaskFlow!({
          requestId: composeRequestId,
          flowInsert: flow,
          stageInsert: stage,
        }),
      ).toEqual({ revisions: { [flowId]: 1, [stageId]: 1 } })

      const composed = await client.readTaskFlow!({ flowRecordId: flowId })
      expect(composed.stage).toMatchObject({
        number: 1,
        workflowKey: DIRECT_TASK_KEY,
        instanceId: '',
        sessionId: 'direct-client-a',
        question: null,
        autonomy: null,
        enforcement: 'note-only',
      })
      expect(
        await client.composeTaskFlow!({
          requestId: newRecordId(),
          stageInsert: stage,
        }),
      ).toEqual({ revisions: { [stageId]: 1 } })

      const secondStageId = newRecordId()
      expect(
        await client.composeTaskFlow!({
          requestId: newRecordId(),
          stageInsert: { ...stage, id: secondStageId, workflowKey: `${DIRECT_TASK_KEY}-second` },
        }),
      ).toEqual({ revisions: { [secondStageId]: 1 } })
      const withSecondStage = await client.readTaskFlow!({ flowRecordId: flowId })
      expect(withSecondStage.otherStages).toContainEqual(
        expect.objectContaining({ id: secondStageId, number: 2 }),
      )

      const advance = {
        requestId: advanceRequestId,
        stage: {
          id: stageId,
          expectedRevision: 1,
          values: {
            activeOrdinal: 1,
            activeSlug: 'implement',
            updatedAt: new Date(Date.now() + 1_000).toISOString(),
          },
        },
        obligationInserts: [
          {
            id: obligationId,
            stageRecordId: stageId,
            stepOrdinal: 1,
            stepSlug: 'implement',
            floor: 'tests',
            requirePullRequest: false,
            expectedExitCode: 0,
            expectedStatus: 'pass',
            floorDeferrable: false,
            reason: 'prove obligation mutation',
            sessionId: 'direct-client-a',
            createdAt: at,
            satisfiedAt: null,
            satisfiedStepOrdinal: null,
            satisfiedStepSlug: null,
            satisfiedEvidence: null,
            abandonedAt: null,
            abandonedReason: null,
            operatorRuling: false,
          },
        ],
        obligationUpdates: [
          {
            id: obligationId,
            stageRecordId: stageId,
            satisfiedAt: at,
            satisfiedStepOrdinal: 1,
            satisfiedStepSlug: 'implement',
            satisfiedEvidence: [{ kind: 'test', status: 'pass' }],
          },
        ],
      }
      expect(await client.advanceTaskFlow!(advance)).toEqual({ revisions: { [stageId]: 2 } })
      expect(await client.advanceTaskFlow!(advance)).toEqual({ revisions: { [stageId]: 2 } })
      expect(
        (await client.readTaskFlow!({ flowRecordId: flowId })).stage?.obligations,
      ).toContainEqual(
        expect.objectContaining({
          id: obligationId,
          satisfiedStepSlug: 'implement',
          satisfiedEvidence: [{ kind: 'test', status: 'pass' }],
        }),
      )
      await expect(
        client.advanceTaskFlow!({ ...advance, requestId: newRecordId() }),
      ).rejects.toMatchObject({ condition: `task_flow_stage.id=${stageId}`, currentRevision: '2' })

      expect(await client.composeTaskFlow!({ requestId: newRecordId(), flowInsert: flow })).toEqual(
        {
          revisions: { [flowId]: 1 },
        },
      )
      await expect(
        client.composeTaskFlow!({
          requestId: newRecordId(),
          flowInsert: { ...flow, state: 'done' },
        }),
      ).rejects.toMatchObject({ condition: `task_flow.id=${flowId}` })

      const otherSpace = await auth.api.createOrganization({
        headers: bearerHeaders(input.token()),
        body: {
          name: 'Direct Task Flow Isolation Proof',
          slug: `direct-task-flow-isolation-${taskId.slice(-8)}`,
          keepCurrentActiveOrganization: true,
        },
      })
      await expect(
        client.advanceTaskFlow!(
          {
            ...advance,
            requestId: newRecordId(),
            stage: { ...advance.stage, expectedRevision: 2 },
          },
          { destinationSpaceId: otherSpace.id },
        ),
      ).rejects.toMatchObject({ condition: `task_flow_stage.id=${stageId}` })

      input.admin(`UPDATE task_flow_stage SET project_id=NULL WHERE id='${stageId}';`)
      const moveTotal = Number(
        input.admin(
          `SELECT sum(row_count) FROM record_move_project_space('${input.spaceId()}','${PROJECT}','${otherSpace.id}',NULL);`,
        ),
      )
      input.admin(
        `SELECT sum(row_count) FROM record_move_project_space('${input.spaceId()}','${PROJECT}','${otherSpace.id}',${moveTotal});`,
      )
      expect(input.admin(`SELECT space_id FROM task_flow_stage WHERE id='${stageId}';`)).toBe(
        otherSpace.id,
      )
    } finally {
      await auth.close()
    }
  })

  test('hosted task-flow read-through advances across machines and remains space isolated', async () => {
    const machineA = newRecordId()
    const machineB = newRecordId()
    const taskId = newRecordId()
    const configRoot = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-task-flow-proof-`))
    const previousConfigRoot = process.env.BOTTEGA_CONFIG_HOME
    const databaseA = proofDatabase(input.projectId())
    let databaseB: Database | undefined
    const auth = testRecordAuth(input.urls().actor, input.urls().auth)
    try {
      process.env.BOTTEGA_CONFIG_HOME = configRoot
      input.admin(`
        INSERT INTO hub_task
          (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
           first_seen,last_seen,created_at,updated_at)
        VALUES ('${taskId}','${input.spaceId()}','${PROJECT}','${input.projectId()}',
          '${TASK_KEY}','${PROJECT}','task-flow takeover proof','active','active','local',
          now(),now(),now(),now());
      `)
      await setActiveRecordSpaceForSession(
        input.urls().actor,
        bearerHeaders(input.token()),
        input.spaceId(),
      )

      input.signIn()
      const client = recordApiClient()
      rememberHostedRecord(databaseA)
      rememberProjectSpace(databaseA, PROJECT, input.spaceId())
      await client.ensureSpaceBuiltIns!({ destinationSpaceId: input.spaceId() })
      await pullRecordCache(databaseA)
      databaseB = Database.deserialize(databaseA.serialize())
      databaseB.exec('PRAGMA foreign_keys=ON')

      setMachineValue('machine.id', machineA)
      const opened = composeWorkflowWithCursor(
        WORKFLOW,
        PROJECT,
        'default',
        { key: TASK_KEY },
        { session: 'machine-a', taskRecordId: taskId, taskStatusCategory: 'active' },
        databaseA,
        {},
        {},
      )
      expect(opened.cursor?.opened).toBe(true)
      const localIds = databaseA
        .query<
          { flow_id: string; stage_id: string },
          []
        >(`SELECT flow.record_id flow_id,cursor.record_id stage_id
           FROM task_flow flow JOIN workflow_cursor cursor
             ON cursor.record_id=flow.open_stage_cursor_record_id`)
        .get()!

      input.signIn()
      expect(
        await syncRecord({
          local: databaseA,
          identity: { id: machineA, name: 'Machine A' },
          projectSpaces: { [PROJECT]: input.spaceId() },
        }),
      ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })

      // Machine B is the same user's second machine: takeover is cross-machine for one user, and a
      // flow belongs to its user within the space, so another member's push is refused by design.
      input.signIn()
      const byTask = await client.readTaskFlow!({ taskKey: TASK_KEY })
      const byFlow = await client.readTaskFlow!({ flowRecordId: localIds.flow_id })
      for (const hosted of [byTask, byFlow]) {
        expect(hosted.flow.id).toBe(localIds.flow_id)
        expect(hosted.stage).toMatchObject({
          id: localIds.stage_id,
          openedMachineId: machineA,
          lastAdvancedMachineId: machineA,
          takenOverFromMachineId: null,
          holder: { id: machineA, displayName: 'Machine A' },
        })
        expect(hosted.otherStages?.map((stage) => stage.id)).not.toContain(localIds.stage_id)
      }

      await readThroughTaskFlow(databaseB, { taskKey: TASK_KEY, taskRecordId: taskId })
      setMachineValue('machine.id', machineB)
      // The built-in diagnose step has a recorded-artifact floor; this proof exercises takeover.
      databaseB
        .query("UPDATE workflow_cursor SET enforcement='note-only' WHERE record_id=?")
        .run(localIds.stage_id)
      const advanced = nextWorkflowStep(
        WORKFLOW,
        PROJECT,
        'default',
        { key: TASK_KEY },
        'machine B completed the first proof step',
        {
          session: 'machine-b',
          taskRecordId: taskId,
          taskStatusCategory: 'active',
          taskFlowRead: { status: 'reachable', holder: byTask.stage!.holder },
        },
        databaseB,
        {},
        testPorts,
      )
      expect(advanced).toStartWith('Took over this workflow stage from Machine A.')
      expect(
        await syncRecord({
          local: databaseB,
          identity: { id: machineB, name: 'Machine B' },
          projectSpaces: { [PROJECT]: input.spaceId() },
        }),
      ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })

      const hostedStage = () =>
        input.admin(
          `SELECT revision || '|' || taken_over_from_machine_id || '|' || last_advanced_machine_id
           FROM task_flow_stage WHERE id='${localIds.stage_id}';`,
        )
      const afterTakeover = hostedStage()
      expect(afterTakeover).toBe(`${byTask.stage!.revision + 1}|${machineA}|${machineB}`)
      databaseB
        .query(
          `UPDATE outbox SET synced_at=NULL WHERE id=(
             SELECT id FROM outbox WHERE kind='task_flow_stage' AND row_id=? ORDER BY id DESC LIMIT 1
           )`,
        )
        .run(localIds.stage_id)
      expect(
        await syncRecord({
          local: databaseB,
          identity: { id: machineB, name: 'Machine B' },
          projectSpaces: { [PROJECT]: input.spaceId() },
        }),
      ).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
      expect(hostedStage()).toBe(afterTakeover)

      input.signIn()
      expect(await client.readTaskFlow!({ taskKey: TASK_KEY })).toMatchObject({
        stage: {
          id: localIds.stage_id,
          takenOverFromMachineId: machineA,
          lastAdvancedMachineId: machineB,
          holder: { id: machineB, displayName: 'Machine B' },
        },
      })

      abandonCursor(
        WORKFLOW,
        PROJECT,
        'default',
        { key: TASK_KEY },
        'postgres proof closes the hosted stage',
        {
          session: 'machine-b',
          taskRecordId: taskId,
          taskStatusCategory: 'active',
          taskFlowRead: { status: 'reachable' },
        },
        databaseB,
      )
      const closedRevision = databaseB
        .query<{ revision: number }, [string]>(
          'SELECT revision FROM workflow_cursor WHERE record_id=?',
        )
        .get(localIds.stage_id)!.revision
      expect(
        await syncRecord({
          local: databaseB,
          identity: { id: machineB, name: 'Machine B' },
          projectSpaces: { [PROJECT]: input.spaceId() },
        }),
      ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })
      input.signIn()
      const afterClose = await client.readTaskFlow!({ taskKey: TASK_KEY })
      expect(afterClose.stage).toBeNull()
      expect(afterClose.otherStages).toContainEqual(
        expect.objectContaining({
          id: localIds.stage_id,
          revision: closedRevision,
          state: 'abandoned',
        }),
      )

      const otherSpace = await auth.api.createOrganization({
        headers: bearerHeaders(input.token()),
        body: {
          name: 'Task Flow Isolation Proof',
          slug: `task-flow-isolation-${taskId.slice(-8)}`,
          keepCurrentActiveOrganization: true,
        },
      })
      await expect(
        client.readTaskFlow!({ taskKey: TASK_KEY }, { destinationSpaceId: otherSpace.id }),
      ).rejects.toThrow('hosted task flow was not found')
      await expect(
        client.readTaskFlow!(
          { flowRecordId: localIds.flow_id },
          { destinationSpaceId: otherSpace.id },
        ),
      ).rejects.toThrow('hosted task flow was not found')
    } finally {
      await auth.close()
      databaseA.close()
      databaseB?.close()
      if (previousConfigRoot === undefined) delete process.env.BOTTEGA_CONFIG_HOME
      else process.env.BOTTEGA_CONFIG_HOME = previousConfigRoot
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
}
