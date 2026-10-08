// concern: workflows
/** Measures whether production workflow step bodies render for registered projects. */

import type { Database } from 'bun:sqlite'
import type { WorkflowFactSource } from '../project/project-injection.ts'
import type { Project } from '../project/projects.ts'
import {
  type AutonomyPreset,
  type AutonomyStage,
  type AutonomyValue,
  builtInAutonomyScope,
  catalogueStepsForAutonomy,
  resolveAutonomy,
} from './autonomy.ts'
import { resolveWorkflowProjectFacts } from './workflow-project-facts.ts'
import { resolveWorkflowTemplate } from './workflow-template.ts'

type RenderCheckWorkflowDefinition = {
  defaultPreset?: AutonomyPreset
  arguments: { name: string }[]
  modes: { slug: string; steps: string[] }[]
}
type RenderCheckCatalogueStep = {
  slug: string
  body: string
  stage?: AutonomyStage
  autonomy: AutonomyValue
  needs: WorkflowFactSource[]
}
type RenderCheckCatalogueDefinition = { steps: RenderCheckCatalogueStep[] }

export type WorkflowPlaceholderFailure = {
  project: string
  workflow: string
  mode: string
  step: string
  placeholder: string
}

type WorkflowFactResolutionFailure = {
  project: string
  workflows: string[]
  facts: string[]
}

export type WorkflowRenderCheckResult = {
  failures: WorkflowPlaceholderFailure[]
  unresolvedProjects: WorkflowFactResolutionFailure[]
}

export type ResolvedWorkflowRenderFacts = {
  project: string
  arguments: Record<string, string>
  facts: Record<string, unknown>
}

const placeholderPaths = (body: string): string[] => [
  ...new Set([...body.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!)),
]

/** Purely report every step-body placeholder that the supplied project facts cannot render. */
export function unresolvedWorkflowStepPlaceholders(
  workflowSlug: string,
  workflow: RenderCheckWorkflowDefinition,
  catalogue: RenderCheckCatalogueDefinition,
  resolved: ResolvedWorkflowRenderFacts,
): WorkflowPlaceholderFailure[] {
  const values: Record<string, unknown> = {
    project: resolved.project,
    ...resolved.arguments,
    ...resolved.facts,
  }
  const context = {
    argumentNames: new Set(workflow.arguments.map(({ name }) => name)),
    project: resolved.project,
    key: resolved.arguments.key,
  }
  const bySlug = new Map(catalogue.steps.map((step) => [step.slug, step]))
  const failures: WorkflowPlaceholderFailure[] = []
  for (const mode of workflow.modes) {
    for (const stepSlug of mode.steps) {
      const step = bySlug.get(stepSlug)
      if (!step) continue
      for (const placeholder of placeholderPaths(step.body)) {
        try {
          resolveWorkflowTemplate(`{{${placeholder}}}`, values, context)
        } catch {
          failures.push({
            project: resolved.project,
            workflow: workflowSlug,
            mode: mode.slug,
            step: stepSlug,
            placeholder,
          })
        }
      }
    }
  }
  return failures
}

function standInArguments(
  definition: RenderCheckWorkflowDefinition,
  project: Project,
): Record<string, string> {
  const release = project.settings.release
  return Object.fromEntries(
    definition.arguments.map(({ name }) => {
      if (name === 'key') return [name, 'DEV-1']
      if (name === 'branch') return [name, 'render-check']
      if (name === 'worktree') return [name, '/tmp/render-check']
      if (name === 'depth' && release?.rungs[0]) return [name, release.rungs[0].name]
      return [name, 'render-check']
    }),
  )
}

export function checkWorkflowRendering(
  workflows: { slug: string; definition: RenderCheckWorkflowDefinition }[],
  catalogue: RenderCheckCatalogueDefinition,
  registeredProjects: Project[],
): WorkflowRenderCheckResult {
  const failures: WorkflowPlaceholderFailure[] = []
  const unresolvedByProject = new Map<string, { workflows: Set<string>; facts: Set<string> }>()
  const bySlug = new Map(catalogue.steps.map((step) => [step.slug, step]))
  for (const project of registeredProjects) {
    for (const { slug, definition } of workflows) {
      const result = checkProjectWorkflow(project, slug, definition, catalogue, bySlug)
      if (Array.isArray(result)) failures.push(...result)
      else {
        const unresolved = unresolvedByProject.get(project.name) ?? {
          workflows: new Set<string>(),
          facts: new Set<string>(),
        }
        unresolved.workflows.add(slug)
        for (const fact of result.facts) unresolved.facts.add(fact)
        unresolvedByProject.set(project.name, unresolved)
      }
    }
  }
  const unresolvedProjects = [...unresolvedByProject.entries()].map(
    ([project, unresolved]): WorkflowFactResolutionFailure => ({
      project,
      workflows: [...unresolved.workflows].sort(),
      facts: [...unresolved.facts].sort(),
    }),
  )
  return { failures, unresolvedProjects }
}

function checkProjectWorkflow(
  project: Project,
  slug: string,
  definition: RenderCheckWorkflowDefinition,
  catalogue: RenderCheckCatalogueDefinition,
  bySlug: Map<string, RenderCheckCatalogueStep>,
): WorkflowPlaceholderFailure[] | { facts: string[] } {
  const selected = definition.modes.flatMap((mode) =>
    mode.steps.flatMap((stepSlug) => {
      const step = bySlug.get(stepSlug)
      return step ? [step] : []
    }),
  )
  const args = standInArguments(definition, project)
  try {
    const autonomy = resolveAutonomy(
      catalogueStepsForAutonomy(selected),
      [builtInAutonomyScope(definition.defaultPreset)],
      slug,
    )
    const { facts } = resolveWorkflowProjectFacts(
      { name: project.name, stack: project.stack, settings: project.settings },
      selected.flatMap((step) => step.needs),
      selected.some((step) => step.needs.includes('ship-to') && step.needs.includes('tracker')),
      args,
      autonomy,
    )
    return unresolvedWorkflowStepPlaceholders(slug, definition, catalogue, {
      project: project.name,
      arguments: args,
      facts,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const remedies = message
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2))
    return { facts: remedies.length ? remedies : [message.replaceAll('\n', ' ')] }
  }
}

export function productionWorkflowDefinitions(d: Database) {
  return (
    d
      .query(
        `SELECT w.slug,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id
         WHERE v.status='production' ORDER BY w.slug`,
      )
      .all() as { slug: string; definition: string }[]
  ).map((row) => ({
    slug: row.slug,
    definition: JSON.parse(row.definition) as RenderCheckWorkflowDefinition,
  }))
}

export function workflowRenderCheckLines(result: WorkflowRenderCheckResult): string[] {
  return [
    ...result.failures.map(
      (failure) =>
        `${failure.project}  ${failure.workflow}  ${failure.mode}  ${failure.step}  ${failure.placeholder}`,
    ),
    ...result.unresolvedProjects.map(
      (failure) =>
        `${failure.project}  ${failure.workflows.join(',')}  project facts could not be resolved: ${failure.facts.join('; ')}`,
    ),
  ]
}

export function renderCheckRefusal(result: WorkflowRenderCheckResult): string | null {
  const lines = result.failures.map(
    (failure) =>
      `- project ${failure.project}, workflow ${failure.workflow}, mode ${failure.mode}, step ${failure.step}, placeholder ${failure.placeholder}`,
  )
  if (!lines.length) return null
  return [
    'production workflow steps do not render for every registered project:',
    ...lines,
    "fix the step body or the project's register entry",
  ].join('\n')
}
