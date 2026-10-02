import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  observeRecipeDatabases,
  RECIPE_DATABASE_OBSERVATION_TIMEOUT_MS,
} from './database-inventory.ts'
import type { DatabaseSpawn } from './database-provision.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('tracked recipe database inventory', () => {
  test('continues after one allocation times out and bounds both client connections', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'orch-database-inventory-'))
    roots.push(projectRoot)
    writeFileSync(
      join(projectRoot, '.env'),
      [
        'POSTGRES_URL=postgres://admin:postgres-secret@postgres.local/main',
        'MYSQL_URL=mysql://admin:mysql-secret@mysql.local/main',
      ].join('\n'),
    )
    writeFileSync(
      join(projectRoot, 'recipe.json'),
      JSON.stringify({
        worktree: {
          allocate: {
            databases: {
              stalled: {
                engine: 'postgres',
                name: 'app_pg_{index}',
                provision: { from: 'template_pg', connection: { key: 'POSTGRES_URL' } },
              },
              healthy: {
                engine: 'mysql',
                name: 'app_mysql_{index}',
                provision: { from: 'template_mysql', connection: { key: 'MYSQL_URL' } },
              },
            },
          },
          create: [],
        },
      }),
    )

    const calls: Parameters<DatabaseSpawn>[2][] = []
    const argvs: string[][] = []
    const spawn: DatabaseSpawn = (argv, _cwd, options) => {
      argvs.push(argv)
      calls.push(options)
      if (options.env.PGHOST) {
        return {
          exitCode: null,
          stdout: new Uint8Array(),
          stderr: '',
          timedOut: true,
        }
      }
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode('app_mysql_7\nunrelated\n'),
        stderr: '',
        timedOut: false,
      }
    }

    expect(
      observeRecipeDatabases({ project: 'example', projectRoot, recipePath: 'recipe.json' }, spawn),
    ).toEqual({
      observations: [
        {
          project: 'example',
          allocationKey: 'healthy',
          engine: 'mysql',
          names: ['app_mysql_7'],
          sourceName: 'template_mysql',
          mainName: 'main',
        },
      ],
      errors: [
        `project example database allocation stalled observation failed: postgres database list client timed out after ${RECIPE_DATABASE_OBSERVATION_TIMEOUT_MS}ms; check the database host and client`,
      ],
    })
    expect(calls.map((call) => call.timeoutMs)).toEqual([
      RECIPE_DATABASE_OBSERVATION_TIMEOUT_MS,
      RECIPE_DATABASE_OBSERVATION_TIMEOUT_MS,
    ])
    expect(calls[0]!.env.PGCONNECT_TIMEOUT).toBe('5')
    expect(argvs[1]).toContain('--connect-timeout=5')
  })
})
