// concern: workflows
/** Owns the architect session autonomy slice. Must not own CLI grammar or hook assembly. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { ConfigClient } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import { projectAt } from '../project/projects.ts'
import {
  type AutonomyStage,
  type AutonomyValue,
  autonomyStages,
  catalogueStepsForAutonomy,
  type ShipTo,
  type StageAutonomyValue,
} from './autonomy.ts'
import { HOSTED_AUTONOMY_SCOPE_NAMES, resolveProjectAutonomy } from './autonomy-scopes.ts'
import { readSessionContextCache, writeSessionContextCache } from './session-context-cache.ts'
import { productionStepCatalogue } from './step-catalogue.ts'

const AUTONOMY_SETTER = 'orch config set'

type ArchitectSessionContext =
  | { registered: false }
  | {
      registered: true
      project: string
      rulings: { value: 'agent' | 'user'; scope: string }
      stages: StageSlice[]
      shipTo: ShipToSlice
      warnings?: string[]
      stale?: true
      resolvedAt?: string
      text: string
    }

type ShipToSlice = {
  value: ShipTo
  scope: string
  landing: string | null
  production: string | null
}

type DistinctAutonomy = { value: AutonomyValue; scope: string; steps: number }
type StageSlice =
  | { stage: AutonomyStage; agreed: true; value: StageAutonomyValue; scope: string; steps: number }
  | { stage: AutonomyStage; agreed: false; values: DistinctAutonomy[] }

type Presentation = { log(value: string): void }

function distinctKey(value: AutonomyValue, scope: string) {
  return `${value}\0${scope}`
}

function groupStage(
  stage: AutonomyStage,
  items: { value: AutonomyValue; scope: string }[],
): StageSlice {
  const counts = new Map<string, DistinctAutonomy>()
  for (const item of items) {
    const key = distinctKey(item.value, item.scope)
    const current = counts.get(key)
    if (current) current.steps += 1
    else counts.set(key, { value: item.value, scope: item.scope, steps: 1 })
  }
  const values = [...counts.values()].sort((left, right) =>
    left.value === right.value
      ? left.scope.localeCompare(right.scope)
      : left.value.localeCompare(right.value),
  )
  const only = values[0]!
  if (values.length === 1)
    return { stage, agreed: true, value: only.value, scope: only.scope, steps: only.steps }
  return { stage, agreed: false, values }
}

function stageLine(slice: StageSlice): string {
  if (slice.agreed) return `${slice.stage}: ${slice.value} (${slice.scope})`
  return `${slice.stage}: ${slice.values
    .map((item) => {
      const noun = item.steps === 1 ? 'step' : 'steps'
      return `${item.value} (${item.steps} ${noun}, ${item.scope})`
    })
    .join('; ')}`
}

function shipToLine(shipTo: ShipToSlice): string {
  const phrase =
    shipTo.value === 'branch'
      ? 'push the branch only; nothing is merged'
      : shipTo.value === 'trunk'
        ? shipTo.landing
          ? `merge into ${shipTo.landing}`
          : 'no landing branch declared'
        : !shipTo.landing
          ? 'no landing branch declared'
          : shipTo.production
            ? `merge into ${shipTo.landing}, then promote to ${shipTo.production}`
            : `no production branch declared; merges into ${shipTo.landing}`
  return `ship to: ${shipTo.value} (${phrase}) (${shipTo.scope})`
}

function renderSlice(
  project: string,
  rulings: { value: 'agent' | 'user'; scope: string },
  stages: StageSlice[],
  shipTo: ShipToSlice,
  warnings: string[],
): string {
  return [
    `Autonomy for ${project}, resolved now from ${PLATFORM_NAME}; change it with ${AUTONOMY_SETTER}`,
    `rulings: ${rulings.value} (${rulings.scope})`,
    ...stages.map(stageLine),
    shipToLine(shipTo),
    ...warnings,
  ].join('\n')
}

const hostedScopes = new Set<string>(HOSTED_AUTONOMY_SCOPE_NAMES)

export function staleSessionContext(
  slice: Extract<ArchitectSessionContext, { registered: true }>,
  resolvedAt: string,
  cause: string,
): ArchitectSessionContext {
  let stale = false
  const staleScope = (scope: string) => {
    if (!hostedScopes.has(scope)) return scope
    stale = true
    return `${scope} (stale)`
  }
  const stages = slice.stages.map((stage): StageSlice => {
    if (stage.agreed)
      return {
        ...stage,
        value: hostedScopes.has(stage.scope) && stage.value === 'auto' ? 'review' : stage.value,
        scope: staleScope(stage.scope),
      }
    return {
      ...stage,
      values: stage.values.map((item) => ({
        ...item,
        value: hostedScopes.has(item.scope) && item.value === 'auto' ? 'review' : item.value,
        scope: staleScope(item.scope),
      })),
    }
  })
  const rulings = { ...slice.rulings, scope: staleScope(slice.rulings.scope) }
  const shipTo = { ...slice.shipTo, scope: staleScope(slice.shipTo.scope) }
  const warnings = slice.warnings ?? []
  const lines = [
    `rulings: ${rulings.value} (${rulings.scope})`,
    ...stages.map(stageLine),
    shipToLine(shipTo),
    ...warnings,
  ]
  if (stale)
    lines.unshift(
      `autonomy is stale: last read ${resolvedAt}; ${cause}; auto stages won by the hosted profile are shown as review until a fresh read succeeds`,
    )
  return {
    ...slice,
    rulings,
    stages,
    shipTo,
    ...(warnings.length ? { warnings } : {}),
    ...(stale ? { stale: true, resolvedAt } : {}),
    text: stale ? lines.join('\n') : renderSlice(slice.project, rulings, stages, shipTo, warnings),
  }
}

type SessionContextDependencies = {
  clientFactory?: (signal: AbortSignal) => ConfigClient
  database?: Database
  configEnvironment?: ConfigEnvironment
  stateEnvironment?: StateEnvironment
  now?: () => Date
}

async function architectSessionContext(
  cwd: string,
  dependencies: SessionContextDependencies = {},
): Promise<ArchitectSessionContext> {
  const project = projectAt(cwd, dependencies.database)
  if (!project) return { registered: false }
  const steps = catalogueStepsForAutonomy(productionStepCatalogue().definition.steps)
  const stateEnvironment = dependencies.stateEnvironment ?? process.env
  const cached = readSessionContextCache(project.name, stateEnvironment)
  const resolution = await resolveProjectAutonomy(
    project.name,
    undefined,
    undefined,
    steps,
    {},
    dependencies.clientFactory,
    dependencies.database,
    dependencies.configEnvironment,
    undefined,
    autonomyStages,
    cached?.hosted,
  )
  const byStage = new Map<AutonomyStage, { value: AutonomyValue; scope: string }[]>()
  for (const step of steps) {
    if (!step.stage) continue
    const resolved = resolution.steps[step.slug]
    if (!resolved) continue
    const items = byStage.get(step.stage) ?? []
    items.push(resolved)
    byStage.set(step.stage, items)
  }
  const stages = autonomyStages.flatMap((stage) => {
    const items = byStage.get(stage)
    if (items?.length) return [groupStage(stage, items)]
    const resolved = resolution.stages?.[stage]
    return resolved ? [{ stage, agreed: true as const, ...resolved, steps: 0 }] : []
  })
  const rulings = { value: resolution.rulings.value, scope: resolution.rulings.scope }
  const shipTo: ShipToSlice = {
    ...resolution.shipTo,
    landing: project.settings.trunk ?? null,
    production: project.settings.productionBranch ?? null,
  }
  const warnings = resolution.warnings ?? []
  const slice = {
    registered: true,
    project: project.name,
    rulings,
    stages,
    shipTo,
    ...(warnings.length ? { warnings } : {}),
    text: renderSlice(project.name, rulings, stages, shipTo, warnings),
  } satisfies ArchitectSessionContext
  if (resolution.hosted?.status === 'unavailable' && cached)
    return staleSessionContext(
      slice,
      cached.resolvedAt,
      resolution.hosted.reason ?? 'hosted read failed',
    )
  if (resolution.hosted?.status !== 'unavailable')
    writeSessionContextCache(
      {
        version: 1,
        resolvedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        project: project.name,
        hosted: {
          user: resolution.hosted?.user ?? {},
          space: resolution.hosted?.space ?? {},
        },
      },
      stateEnvironment,
    )
  return slice
}

export async function sessionContextCommand(
  options: { cwd: string; json: boolean },
  presentation: Presentation,
  dependencies: SessionContextDependencies = {},
): Promise<void> {
  const slice = await architectSessionContext(options.cwd, dependencies)
  if (options.json) {
    presentation.log(JSON.stringify(slice))
    return
  }
  if (slice.registered) presentation.log(slice.text)
}
