// concern: tracked recipe database connection observation
/** Samples Postgres sessions for built-in tracked-recipe allocations without classifying them. */

import { databaseAllocationMatcher } from './database-allocation-matcher.ts'
import { readConnectionValue } from './database-connection.ts'
import { type DatabaseSpawn, runDatabaseClient } from './database-provision.ts'
import type { DatabaseCommand } from './database-provision-plan.ts'
import { loadTrackedRecipe } from './recipe-loader.ts'
import type { TrackedRecipe } from './recipe-schema.ts'

type Allocation = NonNullable<NonNullable<TrackedRecipe['allocate']>['databases']>[string]

export const RECIPE_DATABASE_CONNECTION_OBSERVATION_TIMEOUT_MS = 5_000
export const RECIPE_DATABASE_CONNECTION_OBSERVATION_DESCRIPTION =
  'This is a sample taken when orch monitor runs, so a connection that opens and closes between samples is not seen; trees provisioned before this change carry no tag and will show as untagged until they are released.'

export type RecipeDatabaseConnectionRow = {
  datname: string
  applicationName: string
  backendStart: string
  state: string | null
}

export type RecipeDatabaseConnectionObservation = {
  project: string
  allocationKey: string
  rows: RecipeDatabaseConnectionRow[]
}

export type RecipeDatabaseConnectionInventory = {
  description: string
  observations: RecipeDatabaseConnectionObservation[]
  errors: string[]
}

const activityCommand: DatabaseCommand = {
  argv: [
    'psql',
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--dbname=postgres',
    '--tuples-only',
    '--no-align',
    '--command',
    `SELECT json_build_object(
       'datname', datname,
       'application_name', application_name,
       'backend_start', backend_start,
       'state', state
     )::text FROM pg_stat_activity`,
  ],
}

function error(project: string, allocationKey: string, detail: string): string {
  return `project ${project} database allocation ${allocationKey} connection observation failed: ${detail}`
}

function parseRows(stdout: Uint8Array): RecipeDatabaseConnectionRow[] | null {
  try {
    return new TextDecoder()
      .decode(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line) as Record<string, unknown>
        if (
          typeof row.datname !== 'string' ||
          typeof row.application_name !== 'string' ||
          typeof row.backend_start !== 'string' ||
          (typeof row.state !== 'string' && row.state !== null)
        )
          throw new Error('invalid activity row')
        return {
          datname: row.datname,
          applicationName: row.application_name,
          backendStart: row.backend_start,
          state: row.state,
        }
      })
  } catch {
    return null
  }
}

function observeAllocation(input: {
  project: string
  projectRoot: string
  allocationKey: string
  allocation: Allocation & { provision: NonNullable<Allocation['provision']> }
  spawn?: DatabaseSpawn
}): RecipeDatabaseConnectionObservation | string {
  const matched = databaseAllocationMatcher(input.allocation.name)
  if (!matched.ok) return error(input.project, input.allocationKey, matched.detail)
  const connection = {
    key: input.allocation.provision.connection.key,
    file: input.allocation.provision.connection.file ?? '.env',
  }
  const resolved = readConnectionValue(input.projectRoot, connection)
  if (!resolved.ok) return error(input.project, input.allocationKey, resolved.detail)
  let sampled: ReturnType<typeof runDatabaseClient>
  try {
    sampled = runDatabaseClient(
      {
        command: activityCommand,
        engine: 'postgres',
        connectionValue: resolved.value,
        exec: input.allocation.provision.exec,
        cwd: input.projectRoot,
        timeoutMs: RECIPE_DATABASE_CONNECTION_OBSERVATION_TIMEOUT_MS,
      },
      input.spawn,
    )
  } catch {
    return error(
      input.project,
      input.allocationKey,
      `database connection key ${connection.key} in ${connection.file} is unusable; correct that main-checkout value`,
    )
  }
  if (sampled.timedOut)
    return error(
      input.project,
      input.allocationKey,
      `postgres activity client timed out after ${RECIPE_DATABASE_CONNECTION_OBSERVATION_TIMEOUT_MS}ms; check the database host and client`,
    )
  if (sampled.exitCode !== 0)
    return error(
      input.project,
      input.allocationKey,
      'postgres activity query failed; verify the client, execution context, and admin connection',
    )
  const rows = parseRows(sampled.stdout)
  if (!rows)
    return error(
      input.project,
      input.allocationKey,
      'postgres activity query returned unusable rows; verify pg_stat_activity access',
    )
  return {
    project: input.project,
    allocationKey: input.allocationKey,
    rows: rows.filter((row) => matched.matcher.test(row.datname)),
  }
}

/** Sample sessions for every built-in Postgres allocation declared by one main checkout. */
export function observeRecipeDatabaseConnections(
  input: { project: string; projectRoot: string; recipePath: string },
  spawn?: DatabaseSpawn,
): RecipeDatabaseConnectionInventory {
  const loaded = loadTrackedRecipe(input.projectRoot, input.recipePath)
  if (!loaded.ok) {
    return {
      description: RECIPE_DATABASE_CONNECTION_OBSERVATION_DESCRIPTION,
      observations: [],
      errors: [
        `project ${input.project} tracked recipe database connection observation failed: ${loaded.errors.join('; ')}; repair the tracked recipe and retry`,
      ],
    }
  }
  const observations: RecipeDatabaseConnectionObservation[] = []
  const errors: string[] = []
  for (const [allocationKey, allocation] of Object.entries(
    loaded.recipe?.allocate?.databases ?? {},
  )) {
    if (allocation.engine !== 'postgres' || !allocation.provision) continue
    const observed = observeAllocation({
      ...input,
      allocationKey,
      allocation: allocation as Allocation & { provision: NonNullable<Allocation['provision']> },
      spawn,
    })
    if (typeof observed === 'string') errors.push(observed)
    else observations.push(observed)
  }
  return {
    description: RECIPE_DATABASE_CONNECTION_OBSERVATION_DESCRIPTION,
    observations,
    errors,
  }
}
