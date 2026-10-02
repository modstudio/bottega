import { describe, expect, test } from 'bun:test'
import { databaseNameProblem, quotedDatabaseName } from './database-identity.ts'
import { databaseCommandPlan, outputHasExactDatabase } from './database-provision-plan.ts'

const plan = (engine: 'postgres' | 'mysql' | 'mariadb' | 'sqlite', overrides = {}) =>
  databaseCommandPlan({
    engine,
    name: 'app_7',
    from: engine === 'sqlite' ? 'fixtures/base.sqlite' : 'app_base',
    reuse: false,
    projectRoot: '/main',
    treeRoot: '/tree',
    ...overrides,
  })

describe('database provision command planning', () => {
  test('plans postgres create, drop, and exact catalog verification', () => {
    expect(plan('postgres')).toMatchObject({
      create: [{ argv: expect.arrayContaining(['CREATE DATABASE "app_7" TEMPLATE "app_base"']) }],
      drop: { argv: expect.arrayContaining(['DROP DATABASE IF EXISTS "app_7" WITH (FORCE)']) },
      verifyDown: { output: 'names' },
    })
  })

  test('plans mysql and mariadb dump/load without a shell pipeline', () => {
    expect(plan('mysql').create.map((command) => command.argv[0])).toEqual([
      'mysql',
      'mysqldump',
      'mysql',
    ])
    expect(plan('mariadb').create.map((command) => command.argv[0])).toEqual([
      'mariadb',
      'mariadb-dump',
      'mariadb',
    ])
    expect(plan('mysql').create.at(-1)?.input).toBe('dump')
  })

  test('plans sqlite copy and removal within the declared roots', () => {
    expect(plan('sqlite')).toMatchObject({
      create: [{ argv: ['cp', '--', '/main/fixtures/base.sqlite', '/tree/app_7'] }],
      drop: { argv: ['rm', '-f', '--', '/tree/app_7'] },
      verifyDown: { argv: ['test', '!', '-e', '/tree/app_7'] },
    })
  })

  test('carries the reuse decision without changing the command identity', () => {
    expect(plan('postgres', { reuse: true }).reuse).toBeTrue()
    expect(plan('postgres', { reuse: false }).reuse).toBeFalse()
  })
})

describe('database names and exact verification', () => {
  test('validates engine limits and quotes embedded delimiters', () => {
    expect(quotedDatabaseName('postgres', 'team"one')).toBe('"team""one"')
    expect(quotedDatabaseName('mysql', 'team`one')).toBe('`team``one`')
    expect(databaseNameProblem('postgres', 'x'.repeat(64))).toContain('63')
    expect(databaseNameProblem('mysql', 'bad.name')).toContain('dot')
    expect(databaseNameProblem('sqlite', '../main.sqlite')).toContain('relative')
  })

  test('matches exact rows rather than SQL wildcard or substring semantics', () => {
    expect(outputHasExactDatabase('app_10\napp_1_backup\n', 'app_1')).toBeFalse()
    expect(outputHasExactDatabase('app_%\n', 'app_%')).toBeTrue()
    expect(outputHasExactDatabase('app_%_copy\n', 'app_%')).toBeFalse()
  })
})
