import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeRecipeDatabaseConnections } from './database-connection-observation.ts'
import type { DatabaseSpawn } from './database-provision.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('samples only matching built-in postgres allocation activity as orch-admin', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'orch-database-connections-'))
  roots.push(projectRoot)
  writeFileSync(
    join(projectRoot, '.env'),
    [
      'POSTGRES_URL=postgres://admin:secret@postgres.local/main',
      'MYSQL_URL=mysql://admin:secret@mysql.local/main',
    ].join('\n'),
  )
  writeFileSync(
    join(projectRoot, 'recipe.json'),
    JSON.stringify({
      worktree: {
        allocate: {
          databases: {
            app: {
              engine: 'postgres',
              name: 'stopal_orch_{index}',
              provision: { from: 'stopal_base', connection: { key: 'POSTGRES_URL' } },
            },
            ignored: {
              engine: 'mysql',
              name: 'stopal_mysql_{index}',
              provision: { from: 'stopal_base', connection: { key: 'MYSQL_URL' } },
            },
          },
        },
        create: [],
      },
    }),
  )
  const calls: Parameters<DatabaseSpawn>[2][] = []
  const rows = [
    {
      datname: 'stopal_orch_1',
      application_name: 'orch-tree-orch.run=1',
      backend_start: '2026-10-07T12:00:00.000Z',
      state: 'active',
    },
    {
      datname: 'other_1',
      application_name: 'psql',
      backend_start: '2026-10-07T12:00:00.000Z',
      state: 'idle',
    },
    // A background process: no database, no application name.
    {
      datname: null,
      application_name: null,
      backend_start: '2026-10-07T12:00:00.000Z',
      state: null,
    },
    {
      datname: 'stopal_orch_2',
      application_name: null,
      backend_start: '2026-10-07T12:00:00.000Z',
      state: 'idle',
    },
  ]
  const result = observeRecipeDatabaseConnections(
    { project: 'stopal', projectRoot, recipePath: 'recipe.json' },
    (_argv, _cwd, options) => {
      calls.push(options)
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`),
        stderr: '',
      }
    },
  )
  expect(result.errors).toEqual([])
  expect(result.observations).toEqual([
    {
      project: 'stopal',
      allocationKey: 'app',
      rows: [
        {
          datname: 'stopal_orch_1',
          applicationName: 'orch-tree-orch.run=1',
          backendStart: '2026-10-07T12:00:00.000Z',
          state: 'active',
        },
        {
          datname: 'stopal_orch_2',
          applicationName: '',
          backendStart: '2026-10-07T12:00:00.000Z',
          state: 'idle',
        },
      ],
    },
  ])
  expect(calls).toHaveLength(1)
  expect(calls[0]!.env.PGAPPNAME).toBe('orch-admin')
})

describe('postgres activity detector failure', () => {
  test('reports query failures instead of returning an empty observation', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'orch-database-connections-'))
    roots.push(projectRoot)
    writeFileSync(join(projectRoot, '.env'), 'DATABASE_URL=postgres://admin:secret@host/main\n')
    writeFileSync(
      join(projectRoot, 'recipe.json'),
      JSON.stringify({
        worktree: {
          allocate: {
            databases: {
              app: {
                engine: 'postgres',
                name: 'app_{index}',
                provision: { from: 'base', connection: { key: 'DATABASE_URL' } },
              },
            },
          },
          create: [],
        },
      }),
    )
    const result = observeRecipeDatabaseConnections(
      { project: 'example', projectRoot, recipePath: 'recipe.json' },
      () => ({ exitCode: 1, stdout: new Uint8Array(), stderr: 'denied' }),
    )
    expect(result.observations).toEqual([])
    expect(result.errors).toEqual([
      'project example database allocation app connection observation failed: postgres activity query failed; verify the client, execution context, and admin connection',
    ])
  })
})
