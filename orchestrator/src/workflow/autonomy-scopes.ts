// concern: workflows
/** Gathers workflow-autonomy scopes from the project, machine, hosted config, and cursor. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigClient,
  ConfigClientError,
  configClient,
} from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { readMachineAutonomy } from '../../../shared/machine-config.ts'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import {
  type AutonomyLayerRow,
  type AutonomyPreset,
  type AutonomyResolution,
  type AutonomySettings,
  type AutonomyStage,
  builtInAutonomyPreset,
  builtInAutonomyScope,
  combineRulingsSnapshots,
  HOSTED_AUTONOMY_SCOPE_NAMES,
  parseStoredAutonomy,
  resolveAutonomy,
  staleHostedAutonomyWinner,
  staleHostedScope,
} from './autonomy.ts'
import {
  type CachedSessionContext,
  readSessionContextCache,
  type StateEnvironment,
  writeSessionContextCache,
} from './session-context-cache.ts'
import type { CatalogueStep } from './step-catalogue.ts'
import { combineCursorRulings } from './workflow-cursor-autonomy.ts'

export const HOSTED_AUTONOMY_TIMEOUT_MS = 2000

type HostedEntry = Awaited<ReturnType<ConfigClient['listEntries']>>[number]
const hostedSettings = (rows: HostedEntry[], scope: 'user' | 'space') =>
  parseStoredAutonomy(
    rows
      .filter((row) => row.scope === scope && row.key.startsWith('autonomy.'))
      .map((row) => `${row.key.slice(9)}=${row.value}`)
      .join(','),
    `hosted ${scope}`,
  )

type HostedRead =
  | { status: 'available'; user: AutonomySettings; space: AutonomySettings; warnings: string[] }
  | {
      status: 'not-configured'
      user: AutonomySettings
      space: AutonomySettings
      reason: string
      warnings: string[]
    }
  | {
      status: 'unavailable'
      user: AutonomySettings
      space: AutonomySettings
      reason: string
      warnings: string[]
    }

async function readHosted(
  clientFactory: (signal: AbortSignal) => ConfigClient,
  timeoutMs: number,
): Promise<HostedRead> {
  let rows: HostedEntry[]
  try {
    rows = await clientFactory(AbortSignal.timeout(timeoutMs)).listEntries()
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured')
      return { status: 'not-configured', user: {}, space: {}, reason: error.message, warnings: [] }
    const reason =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? `timed out after ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error)
    return { status: 'unavailable', user: {}, space: {}, reason, warnings: [] }
  }
  const user = hostedSettings(rows, 'user')
  const space = hostedSettings(rows, 'space')
  return {
    status: 'available',
    user: user.settings,
    space: space.settings,
    warnings: [user.warning, space.warning].filter((warning): warning is string =>
      Boolean(warning),
    ),
  }
}

function refreshHostedCache(
  project: string,
  hosted: Extract<HostedRead, { status: 'available' }>,
  stateEnvironment: StateEnvironment,
  now: () => Date,
): string | null {
  try {
    writeSessionContextCache(
      {
        version: 1,
        resolvedAt: now().toISOString(),
        project,
        hosted: { user: hosted.user, space: hosted.space },
      },
      stateEnvironment,
    )
    return null
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `warning: could not refresh hosted autonomy cache: ${reason}`
  }
}

function withHostedWarnings(
  resolved: AutonomyResolution,
  hostedWarnings: string[],
): AutonomyResolution {
  const warnings = [...(resolved.warnings ?? []), ...hostedWarnings]
  return { ...resolved, ...(warnings.length ? { warnings } : {}) }
}

function validateSessionAutonomy(session: AutonomySettings): void {
  if (session.shipTo === undefined) return
  throw new Error(
    `ship to is operator-owned and cannot be set at session scope; use ${PLATFORM_SLUG} machine config set autonomy.ship-to <value>`,
  )
}

function staleAutonomyLayer(layer: AutonomyLayerRow): AutonomyLayerRow {
  const scope = staleHostedScope(layer.scope)
  if (scope === layer.scope) return layer
  return {
    ...layer,
    scope,
    preset: null,
    stages: Object.fromEntries(
      Object.entries(layer.stages).map(([stage, value]) => [
        stage,
        value === null ? null : staleHostedAutonomyWinner({ value, scope: layer.scope }).value,
      ]),
    ) as AutonomyLayerRow['stages'],
  }
}

const cachedHostedNote = (reason: string, cached: CachedSessionContext, now: () => Date) =>
  `hosted autonomy settings unavailable: ${reason}; resolved from cached hosted autonomy settings, local and project scopes (cache age ${Math.max(0, now().getTime() - Date.parse(cached.resolvedAt))} ms)`

const builtInHostedNote = (reason: string) =>
  `hosted autonomy settings unavailable: ${reason}; resolved from local and project scopes, then built-in`

export async function resolveProjectAutonomy(
  project: string,
  workflow: string | undefined,
  defaultPreset: AutonomyPreset | undefined,
  steps: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[] = [],
  session: AutonomySettings = {},
  clientFactory: (signal: AbortSignal) => ConfigClient = (signal) =>
    configClient(process.env, fetch, undefined, signal),
  d: Database = db(),
  env: ConfigEnvironment = process.env,
  timeoutMs: number = HOSTED_AUTONOMY_TIMEOUT_MS,
  stages: readonly AutonomyStage[] = [],
  hostedFallback?: CachedSessionContext,
  now: () => Date = () => new Date(),
  stateEnvironment: StateEnvironment = env,
): Promise<AutonomyResolution> {
  validateSessionAutonomy(session)
  const registered = projectByName(project, d)
  if (!registered) throw new Error(`unknown project "${project}"`)
  const local = readMachineAutonomy(project, env)
  const hosted = await readHosted(clientFactory, timeoutMs)
  const cached =
    hosted.status === 'unavailable'
      ? (hostedFallback ?? readSessionContextCache(project, stateEnvironment))
      : null
  const hostedSettings =
    hosted.status === 'unavailable' && cached
      ? cached.hosted
      : { user: hosted.user, space: hosted.space }
  const resolved = resolveAutonomy(
    steps,
    [
      { name: 'session', settings: session },
      { name: 'local project', settings: local.project },
      { name: 'project', settings: registered.settings.autonomy },
      { name: 'local user', settings: local.user },
      { name: HOSTED_AUTONOMY_SCOPE_NAMES[0], settings: hostedSettings.user },
      { name: HOSTED_AUTONOMY_SCOPE_NAMES[1], settings: hostedSettings.space },
      builtInAutonomyScope(defaultPreset ?? builtInAutonomyPreset),
    ],
    workflow,
    stages,
  )
  const cacheWarning =
    hosted.status === 'available'
      ? refreshHostedCache(project, hosted, stateEnvironment, now)
      : null
  const resolution = withHostedWarnings(resolved, [
    ...hosted.warnings,
    ...(cacheWarning ? [cacheWarning] : []),
  ])
  if (hosted.status === 'available') {
    return {
      ...resolution,
      hosted: { status: hosted.status, user: hosted.user, space: hosted.space },
      session,
    }
  }
  if (hosted.status === 'not-configured')
    return {
      ...resolution,
      hosted: { status: hosted.status, reason: hosted.reason },
      note: builtInHostedNote(hosted.reason),
      session,
    }
  if (cached) {
    return {
      ...resolution,
      layers: resolution.layers.map(staleAutonomyLayer),
      steps: Object.fromEntries(
        Object.entries(resolution.steps).map(([slug, winner]) => [
          slug,
          staleHostedAutonomyWinner(winner),
        ]),
      ),
      stages: resolution.stages
        ? Object.fromEntries(
            Object.entries(resolution.stages).map(([stage, winner]) => [
              stage,
              staleHostedAutonomyWinner(winner),
            ]),
          )
        : undefined,
      rulings: { ...resolution.rulings, scope: staleHostedScope(resolution.rulings.scope) },
      shipTo: { ...resolution.shipTo, scope: staleHostedScope(resolution.shipTo.scope) },
      hosted: { status: hosted.status, reason: hosted.reason },
      note: cachedHostedNote(hosted.reason, cached, now),
      session,
    }
  }
  return {
    ...resolution,
    rulings: {
      ...resolution.rulings,
      complete: ['session', 'local project', 'project', 'local user'].includes(
        resolution.rulings.scope,
      ),
      unavailableReason: hosted.reason,
    },
    shipTo: {
      ...resolution.shipTo,
      complete: ['session', 'local project', 'project', 'local user'].includes(
        resolution.shipTo.scope,
      ),
      unavailableReason: hosted.reason,
    },
    hosted: { status: hosted.status, reason: hosted.reason },
    note: builtInHostedNote(hosted.reason),
    session,
  }
}

function workflowRulingsSnapshot(
  project: string,
  taskRecordId: string | null,
  d: Database = db(),
): AutonomyResolution['rulings'] | null {
  if (!taskRecordId) return null
  const rows = d
    .query(
      `SELECT autonomy FROM workflow_cursor
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND task_record_id=? AND state IN ('running','awaiting-ruling')
       ORDER BY updated_at DESC,number DESC`,
    )
    .all(project, taskRecordId) as { autonomy: string | null }[]
  return combineRulingsSnapshots(
    rows.flatMap((row) => {
      if (!row.autonomy) return []
      const snapshot = JSON.parse(row.autonomy) as Partial<AutonomyResolution>
      return snapshot.rulings ? [snapshot.rulings] : []
    }),
  )
}

export async function resolveAnswerRulings(
  project: string,
  options: {
    taskRecordId?: string | null
    clientFactory?: (signal: AbortSignal) => ConfigClient
    database?: Database
    env?: ConfigEnvironment
    timeoutMs?: number
  } = {},
): Promise<AutonomyResolution['rulings']> {
  const {
    taskRecordId = null,
    clientFactory,
    database: d = db(),
    env = process.env,
    timeoutMs = HOSTED_AUTONOMY_TIMEOUT_MS,
  } = options
  const snapshot = workflowRulingsSnapshot(project, taskRecordId, d)
  try {
    const current = (
      await resolveProjectAutonomy(
        project,
        undefined,
        undefined,
        [],
        {},
        clientFactory,
        d,
        env,
        timeoutMs,
      )
    ).rulings
    return snapshot ? combineCursorRulings(snapshot, current) : current
  } catch (error) {
    if (snapshot) return snapshot
    throw error
  }
}
