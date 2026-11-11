import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { closeDatabaseForFixture, DB_PATH, registerOpenHooks } from '../database/db.ts'
import {
  recordAuditSecretsCommand,
  recordMigrateCommand,
  recordSpaceMemberRemoveCommand,
  recordSpaceMoveProjectCommand,
  renderPublicDocDesignationList,
} from './record-command.ts'
import { recordTunnelUnconfiguredRemedy } from './record-tunnel-error.ts'

const project = {
  id: 1,
  recordId: '01990000-0000-7000-8000-000000001214',
  name: 'alpha',
  path: '/tmp/alpha',
  stack: null,
  canon: true,
  retiredAt: null,
  settings: { space: 'source' },
}

function memberRemovalClient(configAccess: boolean, events: string[]) {
  const client = createMemoryRecordApiClient()
  client.whoami = async () => ({
    user: { id: 'user-a', email: 'owner@example.test' },
    activeSpaceId: 'space-a',
    personalSpaceId: null,
    memberships: [
      {
        space_id: 'space-a',
        name: 'Alpha',
        slug: 'alpha',
        role: 'owner',
        permission: 'write',
      },
    ],
  })
  client.listConfigAccess = async (destinationSpaceId) => {
    expect(destinationSpaceId).toBe('space-a')
    return {
      items: [
        {
          email: 'member@example.test',
          role: 'member',
          permission: 'write',
          configAccess,
        },
      ],
    }
  }
  client.withdrawConfigAccess = async (email, destinationSpaceId) => {
    events.push(`withdraw:${email}:${destinationSpaceId}`)
    return {
      revokedMachineKeyIds: ['machine-a'],
      readableSecretKeys: ['DEVELOPMENT_TOKEN'],
    }
  }
  client.removeMember = async ({ email, organizationId }) => {
    events.push(`remove:${email}:${organizationId}`)
  }
  return client
}

describe('record space member remove command', () => {
  test('withdraws config access before removal and prints the withdrawal report', async () => {
    const events: string[] = []
    const output: string[] = []
    installRecordApiClient(memberRemovalClient(true, events))
    try {
      await recordSpaceMemberRemoveCommand('member@example.test', 'alpha', {
        log: (value) => output.push(value),
      })
    } finally {
      installRecordApiClient(createMemoryRecordApiClient())
    }

    expect(events).toEqual([
      'withdraw:member@example.test:space-a',
      'remove:member@example.test:space-a',
    ])
    expect(output).toEqual([
      'revoked machine\tmachine-a',
      'replace development key\tDEVELOPMENT_TOKEN',
      `withdrew config access from member@example.test; replace the listed development keys because ${PLATFORM_SLUG} cannot replace them`,
      'removed member@example.test from alpha',
    ])
  })

  test('skips withdrawal without config access and still removes the member', async () => {
    const events: string[] = []
    const output: string[] = []
    installRecordApiClient(memberRemovalClient(false, events))
    try {
      await recordSpaceMemberRemoveCommand('member@example.test', 'alpha', {
        log: (value) => output.push(value),
      })
    } finally {
      installRecordApiClient(createMemoryRecordApiClient())
    }

    expect(events).toEqual(['remove:member@example.test:space-a'])
    expect(output).toEqual(['removed member@example.test from alpha'])
  })

  test('prints the withdrawal confirmation without a replace clause when no keys are readable', async () => {
    const events: string[] = []
    const output: string[] = []
    const client = memberRemovalClient(true, events)
    client.withdrawConfigAccess = async (email, destinationSpaceId) => {
      events.push(`withdraw:${email}:${destinationSpaceId}`)
      return { revokedMachineKeyIds: [], readableSecretKeys: [] }
    }
    installRecordApiClient(client)
    try {
      await recordSpaceMemberRemoveCommand('member@example.test', 'alpha', {
        log: (value) => output.push(value),
      })
    } finally {
      installRecordApiClient(createMemoryRecordApiClient())
    }

    expect(output).toEqual([
      'withdrew config access from member@example.test',
      'removed member@example.test from alpha',
    ])
  })
})

test('record migrate names the unconfigured tunnel remedy for connection failures', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'record-migrate-command-'))
  const previousConfigHome = process.env[CONFIG_HOME_ENV]
  const previousMigrateUrl = process.env.BOTTEGA_RECORD_MIGRATE_URL
  process.env[CONFIG_HOME_ENV] = configHome
  process.env.BOTTEGA_RECORD_MIGRATE_URL = 'postgres://record.invalid/database'
  try {
    await expect(
      recordMigrateCommand(
        { log: () => {} },
        {
          appliedMigrationCount: async () => 0,
          migrate: async () => {
            throw new Error('Failed to connect')
          },
          migrationCount: () => 0,
          ensureBuiltIns: async () => ({ inserted: 0, alreadyPresent: 0 }),
        },
      ),
    ).rejects.toThrow(
      `Failed to connect\nrecord tunnel is unconfigured; ${recordTunnelUnconfiguredRemedy()}`,
    )
  } finally {
    if (previousConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
    else process.env[CONFIG_HOME_ENV] = previousConfigHome
    if (previousMigrateUrl === undefined) delete process.env.BOTTEGA_RECORD_MIGRATE_URL
    else process.env.BOTTEGA_RECORD_MIGRATE_URL = previousMigrateUrl
    rmSync(configHome, { recursive: true, force: true })
  }
})

test('break: omitting unresolved rows makes list hide an existing public designation', () => {
  const rows = [
    {
      space_id: 'space-a',
      project_id: 'project-a',
      space_slug: 'alpha',
      project_name: 'one',
      resolvable: true,
    },
    {
      space_id: 'space-b',
      project_id: 'project-b',
      space_slug: null,
      project_name: null,
      resolvable: false,
    },
  ]
  expect(renderPublicDocDesignationList(rows, false)).toEqual([
    'alpha\tone\tspace-a\tproject-a',
    '-\t-\tspace-b\tproject-b\tunresolvable',
  ])
  expect(JSON.parse(renderPublicDocDesignationList(rows, true)[0]!)).toEqual(rows)
  expect(renderPublicDocDesignationList([], false)).toEqual(['no project is designated'])
  expect(renderPublicDocDesignationList([], true)).toEqual(['[]'])
})

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
    const keeper = new Database(DB_PATH)
    keeper.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE; COMMIT;')
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
      expect(JSON.parse(output.join(''))).toEqual({ counts: [], releasedSkipped: 0 })
    } finally {
      restore()
      keeper.close()
    }
  })
})
