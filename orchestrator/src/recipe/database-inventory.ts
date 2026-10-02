// concern: tracked recipe database inventory
/** Reads one tracked recipe and observes only provisioned server database namespaces. */

import { databaseAllocationMatcher } from './database-allocation-matcher.ts'
import { parseConnectionUrl, readConnectionValue } from './database-connection.ts'
import { type DatabaseSpawn, runDatabaseClient } from './database-provision.ts'
import type { DatabaseCommand } from './database-provision-plan.ts'
import { loadTrackedRecipe } from './recipe-loader.ts'
import type { TrackedRecipe } from './recipe-schema.ts'

type ServerEngine = 'postgres' | 'mysql' | 'mariadb'
type Allocation = NonNullable<NonNullable<TrackedRecipe['allocate']>['databases']>[string]

export const RECIPE_DATABASE_OBSERVATION_TIMEOUT_MS = 5_000

type RecipeDatabaseObservation = {
  project: string
  allocationKey: string
  engine: ServerEngine
  names: string[]
  sourceName: string
  mainName: string | null
}

export type RecipeDatabaseInventory = {
  observations: RecipeDatabaseObservation[]
  errors: string[]
}

function listCommand(engine: ServerEngine): DatabaseCommand {
  if (engine === 'postgres') {
    return {
      argv: [
        'psql',
        '--no-psqlrc',
        '--set=ON_ERROR_STOP=1',
        '--dbname=postgres',
        '--tuples-only',
        '--no-align',
        '--command',
        'SELECT datname FROM pg_database',
      ],
      output: 'names',
    }
  }
  return {
    argv: [
      engine === 'mysql' ? 'mysql' : 'mariadb',
      '--batch',
      '--skip-column-names',
      '--execute=SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA',
    ],
    output: 'names',
  }
}

function connectionDatabase(value: string): string | null {
  const pathname = parseConnectionUrl(value).pathname.replace(/^\/+/, '')
  if (!pathname) return null
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

function error(project: string, allocationKey: string, detail: string): string {
  return `project ${project} database allocation ${allocationKey} observation failed: ${detail}`
}

function observeAllocation(input: {
  project: string
  projectRoot: string
  allocationKey: string
  allocation: Allocation & { engine: ServerEngine; provision: NonNullable<Allocation['provision']> }
  spawn?: DatabaseSpawn
}): RecipeDatabaseObservation | string {
  const { project, projectRoot, allocationKey, allocation } = input
  const matched = databaseAllocationMatcher(allocation.name)
  if (!matched.ok) return error(project, allocationKey, matched.detail)
  const connection = {
    key: allocation.provision.connection.key,
    file: allocation.provision.connection.file ?? '.env',
  }
  const resolved = readConnectionValue(projectRoot, connection)
  if (!resolved.ok) return error(project, allocationKey, resolved.detail)
  let mainName: string | null
  let listed: ReturnType<typeof runDatabaseClient>
  try {
    mainName = connectionDatabase(resolved.value)
    listed = runDatabaseClient(
      {
        command: listCommand(allocation.engine),
        engine: allocation.engine,
        connectionValue: resolved.value,
        exec: allocation.provision.exec,
        cwd: projectRoot,
        timeoutMs: RECIPE_DATABASE_OBSERVATION_TIMEOUT_MS,
      },
      input.spawn,
    )
  } catch {
    return error(
      project,
      allocationKey,
      `database connection key ${connection.key} in ${connection.file} is unusable; correct that main-checkout value`,
    )
  }
  if (listed.timedOut) {
    return error(
      project,
      allocationKey,
      `${allocation.engine} database list client timed out after ${RECIPE_DATABASE_OBSERVATION_TIMEOUT_MS}ms; check the database host and client`,
    )
  }
  if (listed.exitCode !== 0) {
    return error(
      project,
      allocationKey,
      `${allocation.engine} database list client failed; verify the client, execution context, and admin connection`,
    )
  }
  const excluded = new Set([allocation.provision.from, ...(mainName ? [mainName] : [])])
  const names = new TextDecoder()
    .decode(listed.stdout)
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name && matched.matcher.test(name) && !excluded.has(name))
  return {
    project,
    allocationKey,
    engine: allocation.engine,
    names,
    sourceName: allocation.provision.from,
    mainName,
  }
}

/** Observe all matchable provisioned server allocations declared by one main checkout. */
export function observeRecipeDatabases(
  input: { project: string; projectRoot: string; recipePath: string },
  spawn?: DatabaseSpawn,
): RecipeDatabaseInventory {
  const loaded = loadTrackedRecipe(input.projectRoot, input.recipePath)
  if (!loaded.ok) {
    return {
      observations: [],
      errors: [
        `project ${input.project} tracked recipe database observation failed: ${loaded.errors.join('; ')}; repair the tracked recipe and retry`,
      ],
    }
  }
  const observations: RecipeDatabaseObservation[] = []
  const errors: string[] = []
  for (const [allocationKey, allocation] of Object.entries(
    loaded.recipe?.allocate?.databases ?? {},
  )) {
    if (
      !allocation.provision ||
      !(['postgres', 'mysql', 'mariadb'] as const).includes(allocation.engine as ServerEngine)
    )
      continue
    const observed = observeAllocation({
      project: input.project,
      projectRoot: input.projectRoot,
      allocationKey,
      allocation: allocation as Allocation & {
        engine: ServerEngine
        provision: NonNullable<Allocation['provision']>
      },
      spawn,
    })
    if (typeof observed === 'string') errors.push(observed)
    else observations.push(observed)
  }
  return { observations, errors }
}
