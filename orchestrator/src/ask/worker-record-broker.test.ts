import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type {
  HostedTaskFlowStageById,
  HostedTaskFlowTextById,
} from '../record/record-task-flow-contract.ts'
import {
  readWorkerTask,
  readWorkerTaskDocument,
  readWorkerWorkflowText,
} from './worker-record-broker.ts'
import type { WorkerHostedTaskDetail, WorkerRecordClient } from './worker-record-client.ts'

const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const CHILD_ID = '01990000-0000-7000-8000-000000000002'
const PARENT_ID = '01990000-0000-7000-8000-000000000003'
const FOREIGN_ID = '01990000-0000-7000-8000-000000000004'
const LIVE_TEXT_ID = '01990000-0000-7000-8000-000000000005'
const FOREIGN_TEXT_ID = '01990000-0000-7000-8000-000000000006'
const MISSING_TEXT_ID = '01990000-0000-7000-8000-000000000007'
const LIVE_STAGE_ID = '01990000-0000-7000-8000-000000000008'
const FOREIGN_STAGE_ID = '01990000-0000-7000-8000-000000000009'
const MISSING_DOCUMENT_ID = '01990000-0000-7000-8000-000000000010'

function detail(input: {
  id: string
  key: string
  projectId: string
  parentId: string | null
  document?: boolean
}): WorkerHostedTaskDetail {
  return {
    task: {
      id: input.id,
      key: input.key,
      projectId: input.projectId,
      parent_id: input.parentId,
      parent_key: null,
    },
    comments: [],
    documents: input.document
      ? [{ id: `${input.id}-document`, task_id: input.id, task_key: input.key, number: 1 }]
      : [],
  }
}

test('the broker walks and enforces the run task scope before returning hosted reads', async () => {
  const projectId = fixtureProjectRecordId(db())
  const project = db()
    .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
    .get(projectId)!.name
  db()
    .query('UPDATE project SET settings=? WHERE record_id=?')
    .run(JSON.stringify({ tracker: { protocol: 'hub' } }), projectId)
  rememberProjectSpace(db(), project, SPACE_ID)
  const runId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    taskRecordId: CHILD_ID,
    projectRecordId: projectId,
  })
  db()
    .query('UPDATE run SET launch_key=?,run_token=? WHERE record_id=?')
    .run('DEV-2', 'run-token', runId)

  const taskCalls: string[] = []
  const tasks = new Map([
    [
      CHILD_ID,
      detail({ id: CHILD_ID, key: 'DEV-2', projectId, parentId: PARENT_ID, document: true }),
    ],
    [PARENT_ID, detail({ id: PARENT_ID, key: 'DEV-1', projectId, parentId: CHILD_ID })],
  ])
  const workflowText = (id: string): HostedTaskFlowTextById | null => {
    if (id === MISSING_TEXT_ID) return null
    return {
      space_id: SPACE_ID,
      text: {
        id,
        stageRecordId: id === LIVE_TEXT_ID ? LIVE_STAGE_ID : FOREIGN_STAGE_ID,
        stepOrdinal: 1,
        stepSlug: 'build',
        body: 'hosted body',
        createdAt: '2026-11-23T00:00:00.000Z',
      },
      stage: { id: id === LIVE_TEXT_ID ? LIVE_STAGE_ID : FOREIGN_STAGE_ID, number: 42 },
      copy: null,
    }
  }
  const workflowStage = (id: string): HostedTaskFlowStageById =>
    ({
      space_id: SPACE_ID,
      stage: { id },
      flow: {
        taskId: id === LIVE_STAGE_ID ? CHILD_ID : FOREIGN_ID,
        taskKey: id === LIVE_STAGE_ID ? 'DEV-2' : 'DEV-9',
        projectId,
      },
    }) as HostedTaskFlowStageById
  const client: WorkerRecordClient = {
    task: async (identity) => {
      taskCalls.push(identity)
      const found = tasks.get(identity)
      if (!found) throw new Error(`unexpected task fetch ${identity}`)
      return found
    },
    workflowText: async (id) => workflowText(id),
    workflowStage: async (id) => workflowStage(id),
  }
  const dependencies = { client }

  expect(await readWorkerTask(runId, 'run-token', 'DEV-2', undefined, dependencies)).toBe(
    tasks.get(CHILD_ID)!,
  )
  expect(
    (await readWorkerTask(runId, 'run-token', 'DEV-2', undefined, dependencies)).tracker_notice,
  ).toBeUndefined()
  expect(await readWorkerTask(runId, 'run-token', 'DEV-1', undefined, dependencies)).toBe(
    tasks.get(PARENT_ID)!,
  )
  await expect(
    readWorkerTask(runId, 'run-token', 'DEV-9', undefined, dependencies),
  ).rejects.toThrow('outside run task DEV-2')
  expect(taskCalls).not.toContain(FOREIGN_ID)

  expect(
    await readWorkerTaskDocument(runId, 'run-token', 'DEV-2/1', undefined, dependencies),
  ).toMatchObject({ task_key: 'DEV-2', number: 1 })
  await expect(
    readWorkerTaskDocument(runId, 'run-token', MISSING_DOCUMENT_ID, undefined, dependencies),
  ).rejects.toThrow(
    `no task document ${MISSING_DOCUMENT_ID} in run task DEV-2 and its parent chain`,
  )
  await expect(
    readWorkerTaskDocument(runId, 'run-token', 'DEV-2/2', undefined, dependencies),
  ).rejects.toThrow('no task document DEV-2/2 in run task DEV-2 and its parent chain')
  await expect(
    readWorkerTaskDocument(runId, 'run-token', 'DEV-9/1', undefined, dependencies),
  ).rejects.toThrow('outside run task DEV-2')

  expect(
    await readWorkerWorkflowText(runId, 'run-token', LIVE_TEXT_ID, undefined, dependencies),
  ).toEqual({
    kind: 'live',
    id: LIVE_TEXT_ID,
    cursor: 42,
    stepSlug: 'build',
    body: 'hosted body',
  })
  await expect(
    readWorkerWorkflowText(runId, 'run-token', FOREIGN_TEXT_ID, undefined, dependencies),
  ).rejects.toThrow(`workflow text ${FOREIGN_TEXT_ID} was not found or is outside run task DEV-2`)
  await expect(
    readWorkerWorkflowText(runId, 'run-token', MISSING_TEXT_ID, undefined, dependencies),
  ).rejects.toThrow(`workflow text ${MISSING_TEXT_ID} was not found or is outside run task DEV-2`)

  await expect(
    readWorkerTask(runId, 'run-token', 'DEV-2', `${project}-other`, dependencies),
  ).rejects.toThrow(`outside run project ${project}`)
})

test('the broker marks record gaps for a project that keeps its own tracker', async () => {
  const projectId = fixtureProjectRecordId(db())
  const project = db()
    .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
    .get(projectId)!.name
  db()
    .query('UPDATE project SET settings=? WHERE record_id=?')
    .run(JSON.stringify({ tracker: { protocol: 'workspace-mcp' } }), projectId)
  rememberProjectSpace(db(), project, SPACE_ID)
  const runId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    taskRecordId: CHILD_ID,
    projectRecordId: projectId,
  })
  db()
    .query('UPDATE run SET launch_key=?,run_token=? WHERE record_id=?')
    .run('DEV-2', 'run-token', runId)
  const task = detail({ id: CHILD_ID, key: 'DEV-2', projectId, parentId: null })
  const dependencies = {
    client: {
      task: async () => task,
      workflowText: async () => null,
      workflowStage: async () => null,
    } satisfies WorkerRecordClient,
  }

  const shown = await readWorkerTask(runId, 'run-token', 'DEV-2', undefined, dependencies)
  expect(shown.tracker_notice).toContain(`project ${project}'s own tracker, not the record`)
  expect(shown.tracker_notice).toContain(`${PLATFORM_SLUG} workflow attach`)
  await expect(
    readWorkerTaskDocument(runId, 'run-token', MISSING_DOCUMENT_ID, undefined, dependencies),
  ).rejects.toThrow(
    `Project ${project}'s task documents live in its own tracker and are not in the record`,
  )
  await expect(
    readWorkerTaskDocument(runId, 'run-token', MISSING_DOCUMENT_ID, undefined, dependencies),
  ).rejects.toThrow(`${PLATFORM_SLUG} workflow attach`)
})
