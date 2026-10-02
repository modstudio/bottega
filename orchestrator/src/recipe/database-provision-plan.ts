// concern: built-in database lifecycle decisions
/** Plans database commands and exact verification from plain values. Must not read files, secrets, or execute clients. */

import {
  type DatabaseEngine,
  databaseNameProblem,
  quotedDatabaseName,
  relativeDatabasePath,
} from './database-identity.ts'
import type { TrackedRecipe } from './recipe-schema.ts'

export { databaseNameProblem, quotedDatabaseName } from './database-identity.ts'

export type DatabaseCommand = {
  argv: string[]
  input?: 'dump'
  output?: 'dump' | 'names'
}
export type DatabaseCommandPlan = {
  engine: DatabaseEngine
  name: string
  from: string
  reuse: boolean
  inspect: DatabaseCommand | null
  create: DatabaseCommand[]
  drop: DatabaseCommand
  verifyDown: DatabaseCommand | null
}

type DatabaseAllocation = NonNullable<NonNullable<TrackedRecipe['allocate']>['databases']>[string]

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sqlCommand(client: string, sql: string, output?: 'names'): DatabaseCommand {
  return { argv: [client, '--batch', '--skip-column-names', `--execute=${sql}`], output }
}

function sqlPlan(
  engine: Exclude<DatabaseEngine, 'sqlite'>,
  name: string,
  from: string,
  reuse: boolean,
): DatabaseCommandPlan {
  const quotedName = quotedDatabaseName(engine, name)
  const quotedFrom = quotedDatabaseName(engine, from)
  if (engine === 'postgres') {
    const psql = (sql: string, output?: 'names'): DatabaseCommand => ({
      argv: [
        'psql',
        '--no-psqlrc',
        '--set=ON_ERROR_STOP=1',
        '--dbname=postgres',
        '--tuples-only',
        '--no-align',
        '--command',
        sql,
      ],
      output,
    })
    const inspect = psql(
      `SELECT datname FROM pg_database WHERE datname = ${literal(name)}`,
      'names',
    )
    return {
      engine,
      name,
      from,
      reuse,
      inspect,
      create: [psql(`CREATE DATABASE ${quotedName} TEMPLATE ${quotedFrom}`)],
      drop: psql(`DROP DATABASE IF EXISTS ${quotedName} WITH (FORCE)`),
      verifyDown: inspect,
    }
  }
  const client = engine === 'mysql' ? 'mysql' : 'mariadb'
  const dump = engine === 'mysql' ? 'mysqldump' : 'mariadb-dump'
  const inspect = sqlCommand(
    client,
    `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ${literal(name)}`,
    'names',
  )
  return {
    engine,
    name,
    from,
    reuse,
    inspect,
    create: [
      sqlCommand(client, `CREATE DATABASE ${quotedName}`),
      { argv: [dump, '--single-transaction', '--skip-lock-tables', from], output: 'dump' },
      { argv: [client, name], input: 'dump' },
    ],
    drop: sqlCommand(client, `DROP DATABASE IF EXISTS ${quotedName}`),
    verifyDown: inspect,
  }
}

export function databaseCommandPlan(input: {
  engine: DatabaseEngine
  name: string
  from: string
  reuse: boolean
  projectRoot: string
  treeRoot: string
}): DatabaseCommandPlan {
  const problem = databaseNameProblem(input.engine, input.name)
  if (problem) throw new Error(problem)
  if (input.engine !== 'sqlite') {
    const sourceProblem = databaseNameProblem(input.engine, input.from)
    if (sourceProblem) throw new Error(`source ${sourceProblem}`)
    return sqlPlan(input.engine, input.name, input.from, input.reuse)
  }
  if (!relativeDatabasePath(input.from))
    throw new Error('sqlite source must be relative to the project root with no .. segment')
  const source = `${input.projectRoot}/${input.from}`
  const target = `${input.treeRoot}/${input.name}`
  return {
    engine: 'sqlite',
    name: input.name,
    from: input.from,
    reuse: input.reuse,
    inspect: { argv: ['test', '-e', target], output: 'names' },
    create: [{ argv: ['cp', '--', source, target] }],
    drop: { argv: ['rm', '-f', '--', target] },
    verifyDown: { argv: ['test', '!', '-e', target] },
  }
}

/** Match complete output rows only; SQL LIKE and substring matching are forbidden. */
export function outputHasExactDatabase(stdout: string, name: string): boolean {
  return stdout.split(/\r?\n/).some((row) => row.trim() === name)
}

export function provisionedDatabases(recipe: TrackedRecipe): [string, DatabaseAllocation][] {
  return Object.entries(recipe.allocate?.databases ?? {}).filter(
    (entry): entry is [string, DatabaseAllocation] => entry[1].provision !== undefined,
  )
}
