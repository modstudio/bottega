import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  runProjectTaskIdentityDecision,
  runTaskIdentityDecision,
} from './record-sync-run-task-identity.ts'

const TASK_BY_ID = '01990000-0000-7000-8000-000000001771'
const EXISTING_TASK = '01990000-0000-7000-8000-000000001773'
const PROJECT = '01990000-0000-7000-8000-000000001774'
const RUN = '01990000-0000-7000-8000-000000001775'

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

describe('run project and task identity', () => {
  const decideLinks = (overrides: Partial<Parameters<typeof runProjectTaskIdentityDecision>[0]>) =>
    runProjectTaskIdentityDecision({
      runId: RUN,
      payloadProjectId: null,
      taskId: null,
      taskProjectId: null,
      probe: false,
      commandName: PLATFORM_SLUG,
      ...overrides,
    })

  test('keeps the payload project', () => {
    expect(decideLinks({ payloadProjectId: PROJECT })).toEqual({
      projectId: PROJECT,
      taskId: null,
      refusal: null,
    })
  })

  test("fills a task-only run from the task's project", () => {
    expect(decideLinks({ taskId: TASK_BY_ID, taskProjectId: PROJECT })).toEqual({
      projectId: PROJECT,
      taskId: TASK_BY_ID,
      refusal: null,
    })
  })

  test('keeps a projectless task without inventing a project', () => {
    expect(decideLinks({ taskId: TASK_BY_ID })).toEqual({
      projectId: null,
      taskId: TASK_BY_ID,
      refusal: null,
    })
  })

  test('refuses a non-probe with neither project nor task', () => {
    expect(decideLinks({})).toEqual({
      projectId: null,
      taskId: null,
      refusal: `run ${RUN} has no hosted project or task; give the local run a project or task, then run \`${PLATFORM_SLUG} record push --backfill\``,
    })
  })

  test('accepts a probe with neither project nor task', () => {
    expect(decideLinks({ probe: true })).toEqual({
      projectId: null,
      taskId: null,
      refusal: null,
    })
  })
})
