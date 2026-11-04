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
import { pullRecordCache } from '../src/record/record-cache.ts'
import { syncRecord } from '../src/record/record-sync.ts'
import { cacheHostedTaskFlow } from '../src/workflow/task-flow-read-through.ts'
import { composeWorkflowWithCursor, nextWorkflowStep } from '../src/workflow/workflow-cursor.ts'
import { testPorts } from '../src/workflow/workflow-cursor-test.fixture.ts'
import { seedWorkflows } from '../src/workflow/workflow-seeds.ts'
import { installWorkflowStoreFixture } from '../src/workflow/workflow-store.fixture.ts'
import { testRecordAuth } from './fixtures/record-auth-postgres.ts'

type Input = {
  urls(): { actor: string; auth: string }
  spaceId(): string
  projectId(): string
  userB(): string
  token(user: 'a' | 'b'): string
  signIn(user: 'a' | 'b'): void
  admin(statement: string): string
}

const PROJECT = 'auth-a-project'
const WORKFLOW = 'fix-defect'
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
      JSON.stringify({
        trunk: 'main',
        docs: { protocol: 'orch-docs' },
        tracker: { protocol: 'hub' },
      }),
    )
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
    let databaseB: Database | undefined
    const auth = testRecordAuth(input.urls().actor, input.urls().auth)
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
        input.urls().actor,
        bearerHeaders(input.token('b')),
        input.spaceId(),
      )

      input.signIn('a')
      const client = recordApiClient()
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

      input.signIn('a')
      expect(
        await syncRecord({
          local: databaseA,
          identity: { id: machineA, name: 'Machine A' },
          projectSpaces: { [PROJECT]: input.spaceId() },
        }),
      ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })

      input.signIn('b')
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

      input.signIn('a')
      expect(await client.readTaskFlow!({ taskKey: TASK_KEY })).toMatchObject({
        stage: {
          id: localIds.stage_id,
          takenOverFromMachineId: machineA,
          lastAdvancedMachineId: machineB,
          holder: { id: machineB, displayName: 'Machine B' },
        },
      })

      const otherSpace = await auth.api.createOrganization({
        headers: bearerHeaders(input.token('a')),
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
