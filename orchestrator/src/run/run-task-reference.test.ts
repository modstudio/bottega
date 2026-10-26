import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { admitNewRunReference, RUN_REFERENCE_REFUSAL } from './run-task-reference.ts'

afterEach(() => {
  spyOn(Bun, 'spawn').mockRestore()
})

describe('run task reference', () => {
  test('resolves a record id within the recorded project for the run claim', async () => {
    spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => ({
      stdout: JSON.stringify([
        {
          record_id: '01990000-0000-7000-8000-000000000895',
          key: 'SHARED-42',
          project: 'beta',
        },
      ]),
      stderr: '',
      exited: Promise.resolve(0),
      args,
    })) as unknown as typeof Bun.spawn)

    expect(
      await admitNewRunReference({
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
      }),
    ).toMatchObject({ taskRecordId: '01990000-0000-7000-8000-000000000895' })
  })

  test('resolves a project-less launch key through the injected task reader', async () => {
    expect(
      await admitNewRunReference({
        projectName: null,
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
        hubTaskByKeyReader: async (key) =>
          key === 'SHARED-42'
            ? {
                record_id: '01990000-0000-7000-8000-000000000895',
                key: 'SHARED-42',
                project: 'beta',
              }
            : null,
      }),
    ).toMatchObject({ taskRecordId: '01990000-0000-7000-8000-000000000895' })
  })

  test('refuses with the remedy when hub is unavailable and no project can be derived', async () => {
    spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('hub unavailable')
    }) as unknown as typeof Bun.spawn)
    expect(
      admitNewRunReference({
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
      }),
    ).rejects.toThrow(RUN_REFERENCE_REFUSAL)
  })

  test('admits a turn with the links already read from its parent', async () => {
    const spawn = spyOn(Bun, 'spawn')
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
    expect(spawn).not.toHaveBeenCalled()
  })
})
