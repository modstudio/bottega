import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDatabase,
  createProvisionedDatabases,
  type DatabaseSpawn,
  dropAndVerifyDatabase,
  dropProvisionedDatabases,
} from './database-provision.ts'
import { recipeSchema } from './recipe-schema.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(engine: 'postgres' | 'mysql', reuse = false, key = 'DATABASE_URL') {
  const projectRoot = mkdtempSync(join(tmpdir(), 'orch-db-main-'))
  const treeRoot = mkdtempSync(join(tmpdir(), 'orch-db-tree-'))
  roots.push(projectRoot, treeRoot)
  const scheme = engine === 'postgres' ? 'postgres' : 'mysql'
  writeFileSync(join(projectRoot, '.env'), `${key}=${scheme}://admin:super-secret@db.local/base\n`)
  const recipe = recipeSchema.parse({
    allocate: {
      databases: {
        app: {
          engine,
          name: 'app_1',
          provision: {
            from: 'base',
            connection: { key },
            reuse,
            exec: { where: 'container', service: 'database' },
          },
        },
      },
    },
    create: [],
  })
  return {
    allocation: recipe.allocate!.databases!.app!,
    context: { projectRoot, treeRoot, allocations: { app: 'app_1' } },
  }
}

const output = (stdout = '', exitCode = 0) => ({
  exitCode,
  stdout: new TextEncoder().encode(stdout),
  stderr: '',
})

describe('database provision adapter', () => {
  test('passes secrets only through inherited environment and runs in the declared container', () => {
    const { allocation, context } = fixture('postgres')
    const calls: { argv: string[]; env: Record<string, string> }[] = []
    const spawn: DatabaseSpawn = (argv, _cwd, options) => {
      calls.push({ argv, env: options.env })
      return output()
    }
    expect(createDatabase('app', allocation, context, spawn).step.status).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.argv.slice(0, 7)).toEqual([
      'docker',
      'compose',
      'exec',
      '-T',
      '-e',
      'PGHOST',
      '-e',
    ])
    expect(calls.flatMap((call) => call.argv).join(' ')).not.toContain('super-secret')
    expect(calls[0]!.env.PGPASSWORD).toBe('super-secret')
  })

  test('reuses an exact existing name without issuing create', () => {
    const { allocation, context } = fixture('postgres', true)
    let calls = 0
    const spawn: DatabaseSpawn = () => {
      calls += 1
      return output('app_1\n')
    }
    expect(createDatabase('app', allocation, context, spawn)).toMatchObject({
      step: { status: 'ok' },
      owned: false,
    })
    expect(calls).toBe(1)
  })

  test('streams mysql dump bytes into the load client in process', () => {
    const { allocation, context } = fixture('mysql')
    const dump = new TextEncoder().encode('CREATE TABLE example(id INT);')
    const inputs: (Uint8Array | undefined)[] = []
    const spawn: DatabaseSpawn = (argv, _cwd, options) => {
      inputs.push(options.stdin)
      return argv.includes('mysqldump') ? { exitCode: 0, stdout: dump, stderr: '' } : output()
    }
    expect(createDatabase('app', allocation, context, spawn).step.status).toBe('ok')
    expect(inputs.at(-1)).toEqual(dump)
  })

  test('verify-down uses exact returned identities', () => {
    const { allocation, context } = fixture('postgres')
    let calls = 0
    const spawn: DatabaseSpawn = () => {
      calls += 1
      return calls === 2 ? output('app_1_backup\n') : output()
    }
    expect(dropAndVerifyDatabase('app', allocation, context, spawn)).toMatchObject({
      status: 'ok',
      phase: 'verify',
    })
  })

  test('missing connection refuses with the file and key but no value', () => {
    const { allocation, context } = fixture('postgres', false, 'ADMIN_DATABASE_URL')
    writeFileSync(join(context.projectRoot, '.env'), 'OTHER=value\n')
    const outcome = createDatabase('app', allocation, context, () => output())
    expect(outcome.step).toMatchObject({ status: 'refused' })
    expect(outcome.step.detail).toContain('ADMIN_DATABASE_URL')
    expect(outcome.step.detail).toContain('.env')
    expect(outcome.step.detail).not.toContain('value')
  })

  test('compensates only databases created by this attempt', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'orch-db-main-'))
    const treeRoot = mkdtempSync(join(tmpdir(), 'orch-db-tree-'))
    roots.push(projectRoot, treeRoot)
    writeFileSync(
      join(projectRoot, '.env'),
      'DATABASE_URL=postgres://admin:super-secret@db.local/base\n',
    )
    const provision = {
      from: 'base',
      connection: { key: 'DATABASE_URL' },
    }
    const recipe = recipeSchema.parse({
      allocate: {
        databases: {
          reused: { engine: 'postgres', name: 'reused', provision: { ...provision, reuse: true } },
          created: { engine: 'postgres', name: 'created', provision },
          refused: { engine: 'postgres', name: 'refused', provision },
        },
      },
      create: [],
    })
    const calls: string[] = []
    const spawn: DatabaseSpawn = (argv) => {
      const command = argv.join(' ')
      calls.push(command)
      if (command.includes('SELECT datname')) {
        if (command.includes("datname = 'reused'")) return output('reused\n')
        if (command.includes("datname = 'refused'")) return output('refused\n')
      }
      return output()
    }

    const outcome = createProvisionedDatabases(
      recipe,
      {
        projectRoot,
        treeRoot,
        allocations: { reused: 'reused', created: 'created', refused: 'refused' },
      },
      spawn,
    )

    expect(outcome.failure).toMatchObject({ name: 'database refused', status: 'refused' })
    expect(calls.filter((call) => call.includes('DROP DATABASE'))).toEqual([
      expect.stringContaining('DROP DATABASE IF EXISTS "created"'),
    ])
  })

  test('owns only a successful initial create command', () => {
    const postgres = fixture('postgres')
    const postgresCalls: string[] = []
    const postgresOutcome = createProvisionedDatabases(
      recipeSchema.parse({
        allocate: { databases: { app: postgres.allocation } },
        create: [],
      }),
      postgres.context,
      (argv) => {
        const command = argv.join(' ')
        postgresCalls.push(command)
        return command.includes('CREATE DATABASE') ? output('', 1) : output()
      },
    )
    expect(postgresOutcome.ownership).toEqual({ app: false })
    expect(postgresCalls.some((call) => call.includes('DROP DATABASE'))).toBeFalse()

    const mysql = fixture('mysql')
    const mysqlCalls: string[] = []
    const mysqlOutcome = createProvisionedDatabases(
      recipeSchema.parse({
        allocate: { databases: { app: mysql.allocation } },
        create: [],
      }),
      mysql.context,
      (argv) => {
        const command = argv.join(' ')
        mysqlCalls.push(command)
        return command.includes('mysqldump') ? output('', 1) : output()
      },
    )
    expect(mysqlOutcome.ownership).toEqual({ app: true })
    expect(mysqlCalls.some((call) => call.includes('DROP DATABASE'))).toBeTrue()
  })

  test('project-step compensation and teardown drop owned databases but keep reused ones', () => {
    const { context } = fixture('postgres')
    const provision = {
      from: 'base',
      connection: { key: 'DATABASE_URL' },
    }
    const recipe = recipeSchema.parse({
      allocate: {
        databases: {
          reused: { engine: 'postgres', name: 'reused', provision: { ...provision, reuse: true } },
          owned: { engine: 'postgres', name: 'owned', provision },
        },
      },
      create: [],
    })
    const calls: string[] = []
    const spawn: DatabaseSpawn = (argv) => {
      calls.push(argv.join(' '))
      return output()
    }
    const databaseContext = {
      ...context,
      allocations: { reused: 'reused', owned: 'owned' },
    }

    const compensate = dropProvisionedDatabases(
      recipe,
      databaseContext,
      { reused: false, owned: true },
      spawn,
    )
    const teardown = dropProvisionedDatabases(
      recipe,
      databaseContext,
      { reused: false, owned: true },
      spawn,
    )
    const legacy = dropProvisionedDatabases(recipe, databaseContext, undefined, spawn)

    expect([...compensate, ...teardown].filter((step) => step.name === 'database reused')).toEqual([
      expect.objectContaining({ status: 'ok', detail: expect.stringContaining('kept') }),
      expect.objectContaining({ status: 'ok', detail: expect.stringContaining('kept') }),
    ])
    expect(calls.filter((call) => call.includes('DROP DATABASE'))).toEqual([
      expect.stringContaining('DROP DATABASE IF EXISTS "owned"'),
      expect.stringContaining('DROP DATABASE IF EXISTS "owned"'),
    ])
    expect(legacy).toEqual([
      expect.objectContaining({
        status: 'ok',
        detail: expect.stringContaining('no recorded ownership'),
      }),
      expect.objectContaining({
        status: 'ok',
        detail: expect.stringContaining('no recorded ownership'),
      }),
    ])
  })

  test('refuses a symlinked sqlite target ancestor at create and teardown', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'orch-db-main-'))
    const treeRoot = mkdtempSync(join(tmpdir(), 'orch-db-tree-'))
    const outside = mkdtempSync(join(tmpdir(), 'orch-db-outside-'))
    roots.push(projectRoot, treeRoot, outside)
    mkdirSync(join(projectRoot, 'fixtures'))
    writeFileSync(join(projectRoot, 'fixtures', 'base.sqlite'), 'source')
    writeFileSync(join(outside, 'app.sqlite'), 'outside')
    symlinkSync(outside, join(treeRoot, 'data'))
    const recipe = recipeSchema.parse({
      allocate: {
        databases: {
          app: {
            engine: 'sqlite',
            name: 'data/app.sqlite',
            provision: { from: 'fixtures/base.sqlite', connection: { key: 'UNUSED' } },
          },
        },
      },
      create: [],
    })
    const allocation = recipe.allocate!.databases!.app!
    const context = { projectRoot, treeRoot, allocations: { app: 'data/app.sqlite' } }
    const spawn: DatabaseSpawn = () => {
      throw new Error('unsafe sqlite command reached spawn')
    }

    expect(createDatabase('app', allocation, context, spawn).step).toMatchObject({
      status: 'refused',
      detail: expect.stringContaining('symbolic link'),
    })
    expect(dropAndVerifyDatabase('app', allocation, context, spawn)).toMatchObject({
      status: 'refused',
      detail: expect.stringContaining('symbolic link'),
    })
    expect(existsSync(join(outside, 'app.sqlite'))).toBeTrue()
  })
})
