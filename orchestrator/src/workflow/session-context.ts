// concern: workflows
/** Owns the architect session autonomy slice. Must not own CLI grammar or hook assembly. */

import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { projectAt } from '../project/projects.ts'
import {
  type AutonomyStage,
  type AutonomyValue,
  autonomyStages,
  catalogueStepsForAutonomy,
  type ReleaseValue,
  type StageAutonomyValue,
} from './autonomy.ts'
import { resolveProjectStageAutonomy } from './autonomy-scopes.ts'
import { productionStepCatalogue } from './step-catalogue.ts'

const AUTONOMY_SETTER = 'orch config set'

type ArchitectSessionContext =
  | { registered: false }
  | {
      registered: true
      project: string
      rulings: { value: 'agent' | 'user'; scope: string }
      stages: StageSlice[]
      release: ReleaseSlice
      warnings?: string[]
      text: string
    }

type ReleaseSlice = {
  value: ReleaseValue
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

function releaseLine(release: ReleaseSlice): string {
  const phrase =
    release.value === 'push'
      ? 'push the branch only'
      : release.value === 'land'
        ? release.landing
          ? `land to ${release.landing}`
          : 'no landing branch declared'
        : !release.landing
          ? 'no landing branch declared'
          : release.production
            ? `land to ${release.landing}, then promote to ${release.production}`
            : `no production branch declared; lands to ${release.landing}`
  return `release: ${release.value} (${phrase}) (${release.scope})`
}

function renderSlice(
  project: string,
  rulings: { value: 'agent' | 'user'; scope: string },
  stages: StageSlice[],
  release: ReleaseSlice,
  warnings: string[],
): string {
  return [
    `Autonomy for ${project}, resolved now from ${PLATFORM_NAME}; change it with ${AUTONOMY_SETTER}`,
    `rulings: ${rulings.value} (${rulings.scope})`,
    ...stages.map(stageLine),
    releaseLine(release),
    ...warnings,
  ].join('\n')
}

async function architectSessionContext(cwd: string): Promise<ArchitectSessionContext> {
  const project = projectAt(cwd)
  if (!project) return { registered: false }
  const steps = catalogueStepsForAutonomy(productionStepCatalogue().definition.steps)
  const resolution = await resolveProjectStageAutonomy(project.name, steps, autonomyStages)
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
  const release: ReleaseSlice = {
    ...resolution.release,
    landing: project.settings.trunk ?? null,
    production: project.settings.productionBranch ?? null,
  }
  const warnings = resolution.warnings ?? []
  return {
    registered: true,
    project: project.name,
    rulings,
    stages,
    release,
    ...(warnings.length ? { warnings } : {}),
    text: renderSlice(project.name, rulings, stages, release, warnings),
  }
}

export async function sessionContextCommand(
  options: { cwd: string; json: boolean },
  presentation: Presentation,
): Promise<void> {
  const slice = await architectSessionContext(options.cwd)
  if (options.json) {
    presentation.log(JSON.stringify(slice))
    return
  }
  if (slice.registered) presentation.log(slice.text)
}
