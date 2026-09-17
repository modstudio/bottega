import { describe, expect, spyOn, test } from 'bun:test'
import { createMemoryRecordApiClient } from '../test/fixtures/record-api.ts'
import { agentsCommand } from './agent-commands.ts'
import { blockersCommand, healthCommand } from './health-commands.ts'
import { jobsCommand } from './job-commands.ts'
import { stateCommand } from './record-commands.ts'
import { buildSnapshotPayload, publishSnapshotsCommand } from './record-publish.ts'
import type { SnapshotKind } from './record-snapshots.ts'

const flags = { has: (name: string) => name === 'json', flag: () => undefined }

describe('record snapshot payloads', () => {
  test('builders match the JSON command functions', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_789_649_102_000)
    const cases: Array<{
      kind: SnapshotKind
      command(log: (value: string) => void): void | Promise<void>
    }> = [
      { kind: 'state', command: (log) => stateCommand(null, { log, setExitCode() {} }) },
      { kind: 'blockers', command: (log) => blockersCommand(flags, { log }) },
      { kind: 'health', command: (log) => healthCommand(flags, { log }) },
      { kind: 'jobs', command: (log) => jobsCommand(true, { log }) },
      {
        kind: 'agents',
        command: (log) => agentsCommand(true, { log, setExitCode() {} }),
      },
    ]
    for (const item of cases) {
      const output: string[] = []
      await item.command((value) => output.push(value))
      expect(await buildSnapshotPayload(item.kind)).toEqual(JSON.parse(output.join('\n')))
    }
    clock.mockRestore()
  })

  test('one failed kind does not stop the remaining publishes and makes the command fail', async () => {
    const client = createMemoryRecordApiClient()
    const attempted: SnapshotKind[] = []
    client.putSnapshot = async (kind) => {
      attempted.push(kind)
      if (kind === 'health') throw new Error('health refused')
      return { takenAt: '2026-09-17T12:00:00.000Z' }
    }
    const output: string[] = []
    let exitCode = 0
    await publishSnapshotsCommand(
      { log: (value) => output.push(value), setExitCode: (value) => (exitCode = value) },
      {
        client,
        identity: '01990000-0000-7000-8000-000000000001',
        build: async (kind) => ({ kind }),
      },
    )
    expect(attempted).toEqual(['state', 'blockers', 'health', 'jobs', 'agents'])
    expect(output[2]).toMatch(/^health\t\d+\tfailed: health refused$/)
    expect(output[4]).toContain('agents\t')
    expect(exitCode).toBe(1)
  })
})
