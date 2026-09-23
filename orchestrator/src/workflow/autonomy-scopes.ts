// concern: workflows
/** Gathers workflow-autonomy scopes from the project, machine, hosted config, and cursor. */

import type { Database } from 'bun:sqlite'
import {
  ConfigClientError,
  type ConfigClient,
  configClient,
} from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { readMachineAutonomy } from '../../../shared/machine-config.ts'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import {
  type AutonomyResolution,
  type AutonomySettings,
  parseAutonomy,
  resolveAutonomy,
} from './autonomy.ts'
import type { CatalogueStep } from './step-catalogue.ts'

export const HOSTED_AUTONOMY_TIMEOUT_MS = 2000
type HostedEntry = Awaited<ReturnType<ConfigClient['listEntries']>>[number]
export const hostedSettings = (rows: HostedEntry[], scope: 'user' | 'space') =>
  parseAutonomy(
    rows
      .filter((row) => row.scope === scope && row.key.startsWith('autonomy.'))
      .map((row) => `${row.key.slice(9)}=${row.value}`)
      .join(','),
    `hosted ${scope}`,
  )

type HostedRead =
  | { status: 'available'; user: AutonomySettings; space: AutonomySettings }
  | { status: 'not-configured'; user: {}; space: {} }
  | { status: 'unavailable'; user: {}; space: {}; reason: string }

async function readHosted(
  clientFactory: (signal: AbortSignal) => ConfigClient,
  timeoutMs: number,
): Promise<HostedRead> {
  try {
    const rows = await clientFactory(AbortSignal.timeout(timeoutMs)).listEntries()
    return { status: 'available', user: hostedSettings(rows, 'user'), space: hostedSettings(rows, 'space') }
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured')
      return { status: 'not-configured', user: {}, space: {} }
    const reason =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? `timed out after ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error)
    return { status: 'unavailable', user: {}, space: {}, reason }
  }
}

const rulingSetAboveHosted = (settings: (AutonomySettings | undefined)[]) =>
  settings.some(
    (value) => value && (value.rulings !== undefined || value.preset !== undefined),
  )

export async function resolveProjectAutonomy(
  project: string,
  steps: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[] = [],
  session: AutonomySettings = {},
  clientFactory: (signal: AbortSignal) => ConfigClient = (signal) =>
    configClient(process.env, fetch, undefined, signal),
  d: Database = db(),
  env: ConfigEnvironment = process.env,
  timeoutMs: number = HOSTED_AUTONOMY_TIMEOUT_MS,
): Promise<AutonomyResolution> {
  const registered = projectByName(project, d)
  if (!registered) throw new Error(`unknown project "${project}"`)
  const local = readMachineAutonomy(project, env)
  const hosted = await readHosted(clientFactory, timeoutMs)
  const aboveHosted = [session, local.project, registered.settings.autonomy ?? {}, local.user]
  const resolution = resolveAutonomy(steps, [
    { name: 'session', settings: session },
    { name: 'local project', settings: local.project },
    { name: 'project', settings: registered.settings.autonomy },
    { name: 'local user', settings: local.user },
    { name: 'hosted user', settings: hosted.user },
    { name: 'hosted space', settings: hosted.space },
    { name: 'built-in', settings: { preset: 'guided' } },
  ])
  if (hosted.status !== 'unavailable') return { ...resolution, session }
  return {
    ...resolution,
    rulings: {
      ...resolution.rulings,
      complete: rulingSetAboveHosted(aboveHosted),
      unavailableReason: hosted.reason,
    },
    note: `hosted autonomy settings unavailable: ${hosted.reason}; resolved from local and project scopes`,
    session,
  }
}

export function workflowRulingsSnapshot(
  project: string,
  launchKey: string | null,
  d: Database = db(),
): AutonomyResolution['rulings'] | null {
  if (!launchKey) return null
  const row = d
    .query(
      `SELECT autonomy FROM workflow_cursor
       WHERE project=? AND workflow_key=? AND state IN ('running','awaiting-ruling')
       ORDER BY updated_at DESC,id DESC LIMIT 1`,
    )
    .get(project, launchKey) as { autonomy: string | null } | null
  if (!row?.autonomy) return null
  const snapshot = JSON.parse(row.autonomy) as Partial<AutonomyResolution>
  return snapshot.rulings ?? null
}

export async function resolveAnswerRulings(
  project: string,
  launchKey: string | null,
  clientFactory?: (signal: AbortSignal) => ConfigClient,
  d: Database = db(),
  env: ConfigEnvironment = process.env,
  timeoutMs: number = HOSTED_AUTONOMY_TIMEOUT_MS,
): Promise<AutonomyResolution['rulings']> {
  const snapshot = workflowRulingsSnapshot(project, launchKey, d)
  if (snapshot) return snapshot
  return (await resolveProjectAutonomy(project, [], {}, clientFactory, d, env, timeoutMs)).rulings
}
