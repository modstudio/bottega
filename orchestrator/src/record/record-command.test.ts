import { describe, expect, test } from 'bun:test'
import { closeDatabaseForFixture, registerOpenHooks } from '../database/db.ts'
import { recordAuditSecretsCommand, recordSpaceMoveProjectCommand } from './record-command.ts'

const project = {
  id: 1,
  name: 'alpha',
  path: '/tmp/alpha',
  stack: null,
  canon: true,
  retiredAt: null,
  settings: { space: 'source' },
}

describe('record space move-project command', () => {
  test('dry run reports every considered table and does not rewrite the register', async () => {
    const output: string[] = []
    let registerWrites = 0
    await recordSpaceMoveProjectCommand(
      'alpha',
      'destination',
      { dryRun: false },
      { log: (value) => output.push(value) },
      {
        recordUrl: () => 'postgres://fixture',
        findProject: () => project,
        moveProject: async () => ({
          destinationSlug: 'destination',
          total: 2,
          rows: [
            { tableName: 'run', reachedBy: 'project_id', rowCount: 2, moved: false },
            {
              tableName: 'hub_day',
              reachedBy: 'space-and-day aggregate; no project attribution',
              rowCount: 0,
              moved: false,
            },
          ],
        }),
        setProjectSpace: () => {
          registerWrites++
        },
      },
    )
    expect(registerWrites).toBe(0)
    expect(output).toEqual([
      'run\t2\tnot moved\tproject_id',
      'hub_day\t0\tnot moved\tspace-and-day aggregate; no project attribution',
      'dry run: 2 rows would move; rerun with --confirm 2',
    ])
  })

  test('confirmed move updates the declaration after hosted rows move', async () => {
    const events: string[] = []
    await recordSpaceMoveProjectCommand(
      'alpha',
      'destination',
      { dryRun: false, confirm: 1 },
      { log: (value) => events.push(value) },
      {
        recordUrl: () => 'postgres://fixture',
        findProject: () => project,
        moveProject: async () => {
          events.push('hosted')
          return {
            destinationSlug: 'destination',
            total: 1,
            rows: [{ tableName: 'project', reachedBy: 'project.id', rowCount: 1, moved: true }],
          }
        },
        setProjectSpace: (_name, space) => events.push(`register:${space}`),
      },
    )
    expect(events.slice(0, 2)).toEqual(['hosted', 'project\t1\tmoved\tproject.id'])
    expect(events[2]).toBe('register:destination')
    expect(events.at(-1)).toContain('local hosted-row caches were not rewritten')
  })
})

describe('record audit-secrets command', () => {
  test('default open does not enter writable-open hooks', () => {
    closeDatabaseForFixture()
    let entered = 0
    const restore = registerOpenHooks({
      afterWritableOpen: [
        () => {
          entered += 1
        },
      ],
      afterInitialize: [
        () => {
          entered += 1
        },
      ],
    })
    try {
      const output: string[] = []
      recordAuditSecretsCommand({ json: true, ids: false }, { log: (value) => output.push(value) })
      expect(entered).toBe(0)
      expect(JSON.parse(output.join(''))).toEqual({ counts: [] })
    } finally {
      restore()
    }
  })
})
