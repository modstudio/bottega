import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { resolveNewRunLinks } from './run-task-reference.ts'

afterEach(() => {
  spyOn(Bun, 'spawn').mockRestore()
})

describe('run task reference', () => {
  test('resolves a record id within the recorded project for the run claim', async () => {
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => ({
      stdout: JSON.stringify({
        task: {
          record_id: '01990000-0000-7000-8000-000000000895',
          key: 'SHARED-42',
          project: 'beta',
        },
      }),
      exited: Promise.resolve(0),
      args,
    })) as unknown as typeof Bun.spawn)

    expect(
      await resolveNewRunLinks({
        recordId: newRecordId(),
        job: 'understand',
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
      }),
    ).toMatchObject({ taskRecordId: '01990000-0000-7000-8000-000000000895' })
    expect(spawn.mock.calls[0]![0]).toEqual(
      expect.arrayContaining(['task', 'show', 'SHARED-42', '--project', 'beta', '--json']),
    )
  })

  test('leaves the reference null when hub is unavailable', async () => {
    spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('hub unavailable')
    }) as unknown as typeof Bun.spawn)
    expect(
      await resolveNewRunLinks({
        recordId: newRecordId(),
        job: 'understand',
        projectName: 'beta',
        projectRecordId: null,
        key: 'SHARED-42',
        cwd: null,
        launchCwd: null,
        probe: false,
      }),
    ).toEqual({ taskRecordId: null, projectRecordId: null })
  })
})
