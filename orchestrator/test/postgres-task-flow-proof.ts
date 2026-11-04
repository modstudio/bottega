import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { setMachineValue } from '../../shared/machine-config.ts'
import { newRecordId } from '../../shared/record-id.ts'
import { migratedTestDatabase } from '../src/database/test-database.fixture.ts'
import { recordApiClient } from '../src/record/record-api-client.ts'
import { bearerHeaders, setActiveRecordSpaceForSession } from '../src/record/record-auth.ts'
import { syncRecord } from '../src/record/record-sync.ts'
import { cacheHostedTaskFlow } from '../src/workflow/task-flow-read-through.ts'
import { composeWorkflowWithCursor, nextWorkflowStep } from '../src/workflow/workflow-cursor.ts'
import { testPorts } from '../src/workflow/workflow-cursor-test.fixture.ts'
import { seedWorkflows } from '../src/workflow/workflow-seeds.ts'
import { installWorkflowStoreFixture } from '../src/workflow/workflow-store.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from '../src/workflow/workflows.ts'
import { testRecordAuth } from './fixtures/record-auth-postgres.ts'

type Input = {
  actorUrl(): string
  authUrl(): string
  spaceId(): string
  projectId(): string
  userB(): string
  tokenA(): string
  tokenB(): string
  setToken(token: string): void
  admin(statement: string): string
}

const PROJECT = 'auth-a-project'
const WORKFLOW = 'hosted-task-flow-proof'
const TASK_KEY = 'AA-2098'

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
      JSON.stringify({ trunk: 'main', tracker: { protocol: 'hub' } }),
    )
  const draft = setWorkflowLocal(
    WORKFLOW,
    {
      title: 'Hosted task-flow proof',
      description: 'Keeps a stage open across one cross-machine advance.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['score', 'complete'],
        },
      ],
    },
    'real Postgres task-flow proof',
    'test',
    database,
  )
  promoteWorkflowLocal(WORKFLOW, draft.n, 'publish real Postgres proof workflow', 'test', database)
  return database
}

export function registerTaskFlowReadThroughTakeoverProof(input: Input): void {
  test('hosted task-flow read-through advances across machines and remains space isolated', async () => {
    const machineA = newRecordId()
    const machineB = newRecordId()
    const taskId = newRecordId()
    const configRoot = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-task-flow-proof-`))
    const previousConfigRoot = process.env.BOTTEGA_CONFIG_HOME
    const databaseA = proofDatabase(input.projectId())
    const databaseB = Database.deserialize(databaseA.serialize())
    databaseB.exec('PRAGMA foreign_keys=ON')
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    try {
      process.env.BOTTEGA_CONFIG_HOME = configRoot
      input.admin(`
        INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES ('${newRecordId()}','${input.spaceId()}','${input.userB()}','member','write',now())
        ON CONFLICT (space_id,user_id) DO UPDATE SET permission='write';
        INSERT INTO hub_task
          (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
           first_seen,last_seen,created_at,updated_at)
        VALUES ('${taskId}','${input.spaceId()}','${PROJECT}','${input.projectId()}',
          '${TASK_KEY}','${PROJECT}','task-flow takeover proof','active','active','local',
          now(),now(),now(),now());
      `)
      await setActiveRecordSpaceForSession(
        input.actorUrl(),
        bearerHeaders(input.tokenB()),
        input.spaceId(),
      )

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

      input.setToken(input.tokenA())
      expect(
        await syncRecord({
          local: databaseA,
          identity: { id: machineA, name: 'Machine A' },
          projectSpaces: { [PROJECT]: input.spaceId() },
        }),
      ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })

      input.setToken(input.tokenB())
      const client = recordApiClient()
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
      }

      cacheHostedTaskFlow(databaseB, TASK_KEY, byTask)
      setMachineValue('machine.id', machineB)
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
          taskFlowRead: { reachable: true, holder: byTask.stage!.holder },
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

      input.setToken(input.tokenA())
      expect(await client.readTaskFlow!({ taskKey: TASK_KEY })).toMatchObject({
        stage: {
          id: localIds.stage_id,
          takenOverFromMachineId: machineA,
          lastAdvancedMachineId: machineB,
          holder: { id: machineB, displayName: 'Machine B' },
        },
      })

      const otherSpace = await auth.api.createOrganization({
        headers: bearerHeaders(input.tokenA()),
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
      databaseB.close()
      if (previousConfigRoot === undefined) delete process.env.BOTTEGA_CONFIG_HOME
      else process.env.BOTTEGA_CONFIG_HOME = previousConfigRoot
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
}
