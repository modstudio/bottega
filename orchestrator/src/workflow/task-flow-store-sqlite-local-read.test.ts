import { expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  type TaskFlowLocalReadMethod,
  taskFlowLocalReadPlacement,
} from './task-flow-store-methods.ts'
import { sqliteTaskFlowLocalStore } from './task-flow-store-sqlite.ts'

const database = testDatabaseFixture(() => {})

const callLocalRead = {
  conflictingHostedStage: (store) =>
    store.conflictingHostedStage({
      projectRecordId: '',
      workflow: '',
      mode: '',
      key: '',
      recordId: '',
    }),
  openStageForTask: (store) => store.openStageForTask(''),
  flowRecordIdForTask: (store) => store.flowRecordIdForTask(''),
  flowProjectionForTask: (store) => store.flowProjectionForTask(''),
  stageByRecordId: (store) => store.stageByRecordId(''),
  stageRevision: (store) => store.stageRevision(''),
  waitingWorkflowQuestions: (store) => store.waitingWorkflowQuestions(),
  unlinkedWorkflowQuestionIds: (store) => store.unlinkedWorkflowQuestionIds('', ''),
} satisfies Record<
  TaskFlowLocalReadMethod,
  (store: ReturnType<typeof sqliteTaskFlowLocalStore>) => unknown
>

test('every local read requires a transaction', () => {
  const store = sqliteTaskFlowLocalStore(database())
  for (const method of Object.keys(taskFlowLocalReadPlacement) as TaskFlowLocalReadMethod[])
    expect(() => callLocalRead[method](store)).toThrow(
      `${method} requires a transaction; use taskFlowReadStore outside a transaction`,
    )
})
