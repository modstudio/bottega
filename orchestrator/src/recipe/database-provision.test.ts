import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type DatabaseSpawn, dropAndVerifyDatabase } from './database-provision.ts'
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
    expect(createDatabase('app', allocation, context, spawn).status).toBe('ok')
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
    expect(createDatabase('app', allocation, context, spawn).status).toBe('ok')
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
    expect(createDatabase('app', allocation, context, spawn).status).toBe('ok')
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
    expect(outcome).toMatchObject({ status: 'refused' })
    expect(outcome.detail).toContain('ADMIN_DATABASE_URL')
    expect(outcome.detail).toContain('.env')
    expect(outcome.detail).not.toContain('value')
  })
})
