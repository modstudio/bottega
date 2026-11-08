import { describe, expect, test } from 'bun:test'
import { admitNewRunReference, RUN_REFERENCE_REFUSAL } from './run-task-reference.ts'

describe('run task reference', () => {
  test('resolves a record id within the recorded project for the run claim', async () => {
    const task = {
      record_id: '01990000-0000-7000-8000-000000000895',
      key: 'SHARED-42',
      project: 'beta',
    }

    expect(
      await admitNewRunReference({
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskReader: async () => [task],
      }),
    ).toMatchObject({ taskRecordId: '01990000-0000-7000-8000-000000000895' })
  })

  test('does not resolve a project-less launch key through the unscoped task reader', async () => {
    await expect(
      admitNewRunReference({
        projectName: null,
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskReader: async () => {
          throw new Error('a project-less key must not read any project')
        },
      }),
    ).rejects.toThrow(RUN_REFERENCE_REFUSAL)
  })

  test('refuses with the remedy when hub is unavailable and no project can be derived', async () => {
    expect(
      admitNewRunReference({
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskReader: async () => {
          throw new Error('hub unavailable')
        },
      }),
    ).rejects.toThrow(RUN_REFERENCE_REFUSAL)
  })

  test('admits a turn with the links already read from its parent', async () => {
    expect(
      await admitNewRunReference({
        inheritedTaskRecordId: 'parent-task',
        inheritedProjectRecordId: 'parent-project',
        projectName: null,
        projectRecordId: null,
        key: null,
        cwd: null,
        launchCwd: null,
        probe: false,
      }),
    ).toEqual({ taskRecordId: 'parent-task', projectRecordId: 'parent-project' })
  })
})
