// concern: workflows
/** Owns the architect session autonomy slice. Must not own CLI grammar or hook assembly. */

import { projectAt } from '../project/projects.ts'
import {
  type AutonomyStage,
  type AutonomyValue,
  autonomyStages,
  catalogueStepsForAutonomy,
} from './autonomy.ts'
import { resolveProjectAutonomy } from './autonomy-scopes.ts'
import { productionStepCatalogue } from './step-catalogue.ts'

const AUTONOMY_SETTER = 'orch config set'

type ArchitectSessionContext =
  | { registered: false }
  | {
      registered: true
      project: string
      rulings: { value: 'agent' | 'user'; scope: string }
      stages: StageSlice[]
      text: string
    }

type DistinctAutonomy = { value: AutonomyValue; scope: string; steps: number }
type StageSlice =
  | { stage: AutonomyStage; agreed: true; value: AutonomyValue; scope: string; steps: number }
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

function renderSlice(
  project: string,
  rulings: { value: 'agent' | 'user'; scope: string },
  stages: StageSlice[],
): string {
  return [
    `Autonomy for ${project}, resolved now from bottega; change it with ${AUTONOMY_SETTER}`,
    `rulings: ${rulings.value} (${rulings.scope})`,
    ...stages.map(stageLine),
  ].join('\n')
}

async function architectSessionContext(cwd: string): Promise<ArchitectSessionContext> {
  const project = projectAt(cwd)
  if (!project) return { registered: false }
  const steps = catalogueStepsForAutonomy(productionStepCatalogue().definition.steps)
  const resolution = await resolveProjectAutonomy(project.name, undefined, undefined, steps)
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
    return items?.length ? [groupStage(stage, items)] : []
  })
  const rulings = { value: resolution.rulings.value, scope: resolution.rulings.scope }
  return {
    registered: true,
    project: project.name,
    rulings,
    stages,
    text: renderSlice(project.name, rulings, stages),
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
