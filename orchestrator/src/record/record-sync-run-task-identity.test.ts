import { describe, expect, test } from 'bun:test'
import { runTaskIdentityDecision } from './record-sync-run-task-identity.ts'

const TASK_BY_ID = '01990000-0000-7000-8000-000000001771'
const EXISTING_TASK = '01990000-0000-7000-8000-000000001773'

function decide(overrides: Partial<Parameters<typeof runTaskIdentityDecision>[0]>): string | null {
  return runTaskIdentityDecision({
    resolvedTaskId: null,
    existingTaskId: null,
    write: 'insert',
    ...overrides,
  })
}

describe('run task identity', () => {
  test('uses a task reference that resolves in the run space', () => {
    expect(decide({ resolvedTaskId: TASK_BY_ID })).toBe(TASK_BY_ID)
  })

  test('stores null when neither identity resolves on insert', () => {
    expect(decide({ resolvedTaskId: null })).toBeNull()
  })

  test('keeps the existing task when neither identity resolves on update', () => {
    expect(
      decide({
        existingTaskId: EXISTING_TASK,
        write: 'update',
      }),
    ).toBe(EXISTING_TASK)
  })

  test('a resolved task relinks an update away from its existing task', () => {
    expect(
      decide({
        resolvedTaskId: TASK_BY_ID,
        existingTaskId: EXISTING_TASK,
        write: 'update',
      }),
    ).toBe(TASK_BY_ID)
  })
})
