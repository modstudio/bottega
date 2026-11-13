import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import type { RecordWriteDestination } from '../src/record/record-api-client-paths.ts'
import type { RecordTaskFlowClient } from '../src/record/record-api-client-task-flow.ts'
import type { TaskFlowIntentInput } from '../src/record/record-task-flow-write-contract.ts'

type Stage = NonNullable<TaskFlowIntentInput<'compose'>['stageInsert']>

export async function proveTaskFlowRecordReads(input: {
  client: RecordTaskFlowClient
  destination: RecordWriteDestination
  projectId: string
  otherProjectId: string
  taskId: string
  flowId: string
  stage: Stage
  stageId: string
  secondStageId: string
  concurrentStageIds: string[]
  otherProjectStageId: string
  tasklessStageId: string
  workflow: string
}): Promise<void> {
  const keylessStageId = newRecordId()
  const secondaryStageId = newRecordId()
  await input.client.composeTaskFlow!(
    {
      requestId: newRecordId(),
      stageInsert: {
        ...input.stage,
        id: keylessStageId,
        workflowKey: '',
        mode: 'keyless-mode',
        sessionId: 'keyless-proof-session',
      },
    },
    input.destination,
  )
  await input.client.composeTaskFlow!(
    {
      requestId: newRecordId(),
      stageInsert: {
        ...input.stage,
        id: secondaryStageId,
        workflowKey: 'instance-proof',
        instanceId: 'secondary',
        mode: 'alternate',
        sessionId: 'secondary-proof-session',
      },
    },
    input.destination,
  )

  const ids = (page: Awaited<ReturnType<NonNullable<typeof input.client.listTaskFlowStages>>>) =>
    page.items.map((item) => item.stage.id)
  const allStageIds = [
    input.stageId,
    input.secondStageId,
    ...input.concurrentStageIds,
    input.otherProjectStageId,
    input.tasklessStageId,
    keylessStageId,
    secondaryStageId,
  ]
  expect(
    ids(
      await input.client.listTaskFlowStages!({ workflow: input.workflow }, input.destination),
    ).sort(),
  ).toEqual(allStageIds.toSorted())
  expect(
    ids(await input.client.listTaskFlowStages!({ mode: 'alternate' }, input.destination)),
  ).toEqual([secondaryStageId])
  expect(
    ids(
      await input.client.listTaskFlowStages!({ workflowKey: 'instance-proof' }, input.destination),
    ),
  ).toEqual([secondaryStageId])
  expect(ids(await input.client.listTaskFlowStages!({ keyless: true }, input.destination))).toEqual(
    [keylessStageId],
  )
  expect(
    ids(
      await input.client.listTaskFlowStages!({ primaryInstance: true }, input.destination),
    ).sort(),
  ).toEqual(allStageIds.filter((id) => id !== secondaryStageId).toSorted())
  expect(
    ids(await input.client.listTaskFlowStages!({ taskId: input.taskId }, input.destination)).sort(),
  ).toEqual(
    [
      input.stageId,
      input.secondStageId,
      ...input.concurrentStageIds,
      keylessStageId,
      secondaryStageId,
    ].toSorted(),
  )
  expect(
    ids(await input.client.listTaskFlowStages!({ unlinked: true }, input.destination)).sort(),
  ).toEqual([input.tasklessStageId])
  expect(
    ids(await input.client.listTaskFlowStages!({ linked: true }, input.destination)).sort(),
  ).toEqual(allStageIds.filter((id) => id !== input.tasklessStageId).toSorted())
  expect(
    ids(
      await input.client.listTaskFlowStages!(
        { openedMachineId: input.stage.openedMachineId },
        input.destination,
      ),
    ).sort(),
  ).toEqual(allStageIds.toSorted())
  expect(
    (await input.client.readTaskFlow!({ taskId: input.taskId }, input.destination)).flow.id,
  ).toBe(input.flowId)

  const pageEveryStage = async (order: 'project' | 'newest') => {
    const collected: string[] = []
    let cursor: string | undefined
    let lastNextCursor: string | null = null
    do {
      const page = await input.client.listTaskFlowStages!(
        { states: ['running'], order, limit: 2, cursor },
        input.destination,
      )
      collected.push(...ids(page))
      lastNextCursor = page.nextCursor
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return { collected, lastNextCursor }
  }
  for (const order of ['project', 'newest'] as const) {
    const whole = await input.client.listTaskFlowStages!(
      { states: ['running'], order, limit: 100 },
      input.destination,
    )
    const paged = await pageEveryStage(order)
    expect(paged.collected).toEqual(ids(whole))
    expect(new Set(paged.collected).size).toBe(paged.collected.length)
    expect(paged.lastNextCursor).toBeNull()
  }
  const newest = await input.client.listTaskFlowStages!(
    { states: ['running'], order: 'newest', limit: 100 },
    input.destination,
  )
  expect(newest.items.map((item) => item.stage.number)).toEqual(
    newest.items
      .map((item) => item.stage.number)
      .toSorted((left, right) => (right ?? -1) - (left ?? -1)),
  )
  expect(
    await input.client.readTaskFlowProjectReferenceCounts!(input.projectId, input.destination),
  ).toEqual({ stages: 9, flows: 3 })
  expect(
    await input.client.readTaskFlowProjectReferenceCounts!(input.otherProjectId, input.destination),
  ).toEqual({ stages: 1, flows: 1 })
  expect(
    await input.client.readTaskFlowProjectReferenceCounts!(newRecordId(), input.destination),
  ).toEqual({ stages: 0, flows: 0 })
  const absentFlowId = newRecordId()
  const absentStageId = newRecordId()
  expect(
    await input.client.readTaskFlowPresence!(
      {
        flowIds: [input.flowId, absentFlowId],
        stageIds: [input.stageId, input.tasklessStageId, absentStageId],
      },
      input.destination,
    ),
  ).toEqual({
    flowIds: [input.flowId],
    stageIds: [input.stageId, input.tasklessStageId].toSorted(),
  })
}
