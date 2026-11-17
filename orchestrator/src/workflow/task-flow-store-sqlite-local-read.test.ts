import { expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  type TaskFlowLocalReadMethod,
  taskFlowLocalReadMethods,
} from './task-flow-store-methods.ts'
import { sqliteTaskFlowLocalStore } from './task-flow-store-sqlite.ts'

const database = testDatabaseFixture(() => {})

const callLocalRead = {
  openStageForTask: (store) => store.openStageForTask(''),
  flowProjectionForTask: (store) => store.flowProjectionForTask(''),
  stageByRecordId: (store) => store.stageByRecordId(''),
  waitingWorkflowQuestions: (store) => store.waitingWorkflowQuestions(),
} satisfies Record<
  TaskFlowLocalReadMethod,
  (store: ReturnType<typeof sqliteTaskFlowLocalStore>) => unknown
>

test('every local read requires a transaction', () => {
  const store = sqliteTaskFlowLocalStore(database())
  for (const method of taskFlowLocalReadMethods)
    expect(() => callLocalRead[method](store)).toThrow(
      `${method} requires a transaction; use taskFlowReadStore outside a transaction`,
    )
})
