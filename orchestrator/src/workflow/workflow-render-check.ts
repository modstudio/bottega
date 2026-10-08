// concern: workflows
/** Measures whether production workflow step bodies render for registered projects. */

import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'
import {
  builtInAutonomyScope,
  catalogueStepsForAutonomy,
  resolveAutonomy,
} from './autonomy.ts'
import type { StepCatalogueDefinition } from './step-catalogue.ts'
import { resolveWorkflowProjectFacts } from './workflow-project-facts.ts'
import { resolveWorkflowTemplate } from './workflow-template.ts'
import type { WorkflowDefinition } from './workflows.ts'

export type WorkflowPlaceholderFailure = {
  project: string
  workflow: string
  mode: string
  step: string
  placeholder: string
}

export type WorkflowFactResolutionFailure = {
  project: string
  workflow: string
  error: string
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
  workflow: WorkflowDefinition,
  catalogue: StepCatalogueDefinition,
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

function standInArguments(definition: WorkflowDefinition, project: Project): Record<string, string> {
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
  workflows: { slug: string; definition: WorkflowDefinition }[],
  catalogue: StepCatalogueDefinition,
  registeredProjects: Project[],
): WorkflowRenderCheckResult {
  const failures: WorkflowPlaceholderFailure[] = []
  const unresolvedProjects: WorkflowFactResolutionFailure[] = []
  const bySlug = new Map(catalogue.steps.map((step) => [step.slug, step]))
  for (const project of registeredProjects) {
    for (const { slug, definition } of workflows) {
      const selected = definition.modes.flatMap((mode) =>
        mode.steps.flatMap((stepSlug) => {
          const step = bySlug.get(stepSlug)
          return step ? [step] : []
        }),
      )
      const needs = selected.flatMap((step) => step.needs)
      const args = standInArguments(definition, project)
      try {
        const autonomy = resolveAutonomy(
          catalogueStepsForAutonomy(selected),
          [builtInAutonomyScope(definition.defaultPreset)],
          slug,
        )
        const { facts } = resolveWorkflowProjectFacts(
          { name: project.name, stack: project.stack, settings: project.settings },
          needs,
          selected.some(
            (step) => step.needs.includes('ship-to') && step.needs.includes('tracker'),
          ),
          args,
          autonomy,
        )
        failures.push(
          ...unresolvedWorkflowStepPlaceholders(slug, definition, catalogue, {
            project: project.name,
            arguments: args,
            facts,
          }),
        )
      } catch (error) {
        unresolvedProjects.push({
          project: project.name,
          workflow: slug,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return { failures, unresolvedProjects }
}

export function productionWorkflowDefinitions(d: Database) {
  return (
    d
      .query(
        `SELECT w.slug,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id
         WHERE v.status='production' ORDER BY w.slug`,
      )
      .all() as { slug: string; definition: string }[]
  ).map((row) => ({ slug: row.slug, definition: JSON.parse(row.definition) as WorkflowDefinition }))
}

export function renderCheckRefusal(result: WorkflowRenderCheckResult): string | null {
  const lines = [
    ...result.failures.map(
      (failure) =>
        `- project ${failure.project}, workflow ${failure.workflow}, mode ${failure.mode}, step ${failure.step}, placeholder ${failure.placeholder}`,
    ),
    ...result.unresolvedProjects.map(
      (failure) =>
        `- project ${failure.project}, workflow ${failure.workflow}: project facts could not be resolved: ${failure.error}`,
    ),
  ]
  if (!lines.length) return null
  return [
    'production workflow steps do not render for every registered project:',
    ...lines,
    "fix the step body or the project's register entry",
  ].join('\n')
}
