import { describe, expect, test } from 'bun:test'
import { runTaskIdentityDecision } from './record-sync-run-task-identity.ts'

const TASK_BY_ID = '01990000-0000-7000-8000-000000001771'
const TASK_BY_KEY = '01990000-0000-7000-8000-000000001772'
const EXISTING_TASK = '01990000-0000-7000-8000-000000001773'

function decide(overrides: Partial<Parameters<typeof runTaskIdentityDecision>[0]>): string | null {
  return runTaskIdentityDecision({
    payloadTaskId: null,
    payloadTaskKey: null,
    taskFoundById: null,
    taskFoundByKey: null,
    existingTaskId: null,
    write: 'insert',
    ...overrides,
  })
}

describe('run task identity', () => {
  test('uses a task id that resolves in the run space', () => {
    expect(decide({ payloadTaskId: TASK_BY_ID, taskFoundById: TASK_BY_ID })).toBe(TASK_BY_ID)
  })

  test('uses the task key when the task id is unknown', () => {
    expect(
      decide({
        payloadTaskId: '01990000-0000-7000-8000-000000001799',
        payloadTaskKey: 'DEV-1771',
        taskFoundByKey: TASK_BY_KEY,
      }),
    ).toBe(TASK_BY_KEY)
  })

  test('stores null when neither identity resolves on insert', () => {
    expect(decide({ payloadTaskId: '01990000-0000-7000-8000-000000001799' })).toBeNull()
  })

  test('keeps the existing task when neither identity resolves on update', () => {
    expect(
      decide({
        payloadTaskId: '01990000-0000-7000-8000-000000001799',
        existingTaskId: EXISTING_TASK,
        write: 'update',
      }),
    ).toBe(EXISTING_TASK)
  })

  test('uses a resolvable key when the payload task id is null', () => {
    expect(
      decide({ payloadTaskId: null, payloadTaskKey: 'DEV-1771', taskFoundByKey: TASK_BY_KEY }),
    ).toBe(TASK_BY_KEY)
  })

  test('uses a resolvable key when the payload task id is omitted', () => {
    expect(
      decide({ payloadTaskId: undefined, payloadTaskKey: 'DEV-1771', taskFoundByKey: TASK_BY_KEY }),
    ).toBe(TASK_BY_KEY)
  })
})
