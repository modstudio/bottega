// concern: workflows
/** Measures whether production workflow step bodies render for registered projects. */

import { MissingWorkflowInjectionFactsError } from '../project/project-injection.ts'
import type { Project } from '../project/projects.ts'
import { builtInAutonomyScope, catalogueStepsForAutonomy, resolveAutonomy } from './autonomy.ts'
import type { CatalogueStep, StepCatalogueDefinition } from './step-catalogue-definition.ts'
import type { WorkflowDefinition, WorkflowMode } from './workflow-definition.ts'
import { resolveWorkflowProjectFacts, stepNeedsCloseState } from './workflow-project-facts.ts'
import { expandWorkflowSteps } from './workflow-step-sequences.ts'
import {
  resolveWorkflowStepTemplate,
  resolveWorkflowTemplate,
  type WorkflowStepTemplateField,
  workflowStepTemplates,
  workflowTemplatePlaceholders,
} from './workflow-template.ts'

export type WorkflowPlaceholderFailure = {
  project: string
  workflow: string
  mode: string
  step: string
  field: WorkflowStepTemplateField
  placeholder: string
}

type WorkflowFactResolutionFailure = {
  project: string
  workflows: string[]
  facts: string[]
}

type WorkflowStepResolutionFailure = {
  project: string
  workflow: string
  mode: string
  step: string
  reason: string
}

export type WorkflowRenderCheckResult = {
  failures: WorkflowPlaceholderFailure[]
  unresolvedProjects: WorkflowFactResolutionFailure[]
  resolutionFailures: WorkflowStepResolutionFailure[]
}

export type ResolvedWorkflowRenderFacts = {
  project: string
  arguments: Record<string, string>
  facts: Record<string, unknown>
}

function unresolvedStepPlaceholders(
  project: string,
  workflowSlug: string,
  mode: string,
  step: CatalogueStep,
  values: Record<string, unknown>,
  context: { argumentNames: ReadonlySet<string>; project: string; key?: string },
): WorkflowPlaceholderFailure[] {
  return workflowStepTemplates(step).flatMap(({ field, template }) =>
    workflowTemplatePlaceholders(template).flatMap((placeholder) => {
      try {
        resolveWorkflowStepTemplate(step.slug, field, `{{${placeholder}}}`, (value) =>
          resolveWorkflowTemplate(value, values, context),
        )
        return []
      } catch {
        return [{ project, workflow: workflowSlug, mode, step: step.slug, field, placeholder }]
      }
    }),
  )
}

/** Purely report every step-field placeholder that the supplied project facts cannot render. */
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
  return workflow.modes.flatMap((mode) =>
    expandWorkflowSteps(mode.steps, catalogue.sequences ?? []).flatMap((stepSlug) => {
      const step = bySlug.get(stepSlug)
      return step
        ? unresolvedStepPlaceholders(
            resolved.project,
            workflowSlug,
            mode.slug,
            step,
            values,
            context,
          )
        : []
    }),
  )
}

function standInArguments(
  definition: WorkflowDefinition,
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

type StepCheckResult =
  | { kind: 'placeholders'; failures: WorkflowPlaceholderFailure[] }
  | { kind: 'missing-facts'; facts: string[] }
  | { kind: 'resolution'; reason: string }

function checkStepRendering(
  project: Project,
  workflowSlug: string,
  definition: WorkflowDefinition,
  mode: WorkflowMode,
  step: CatalogueStep,
  args: Record<string, string>,
): StepCheckResult {
  try {
    const autonomy = resolveAutonomy(
      catalogueStepsForAutonomy([step]),
      [builtInAutonomyScope(definition.defaultPreset)],
      workflowSlug,
    )
    const { facts } = resolveWorkflowProjectFacts(
      { name: project.name, stack: project.stack, settings: project.settings },
      step.needs,
      stepNeedsCloseState(step.needs),
      args,
      autonomy,
    )
    return {
      kind: 'placeholders',
      failures: unresolvedWorkflowStepPlaceholders(
        workflowSlug,
        { ...definition, modes: [{ ...mode, steps: [step.slug] }] },
        { steps: [step] },
        { project: project.name, arguments: args, facts },
      ),
    }
  } catch (error) {
    return error instanceof MissingWorkflowInjectionFactsError
      ? { kind: 'missing-facts', facts: error.missing.map(({ remedy }) => remedy) }
      : {
          kind: 'resolution',
          reason: error instanceof Error ? error.message.replaceAll('\n', ' ') : String(error),
        }
  }
}

type RenderCheckAccumulator = {
  failures: WorkflowPlaceholderFailure[]
  resolutionFailures: WorkflowStepResolutionFailure[]
  unresolvedByProject: Map<string, { workflows: Set<string>; facts: Set<string> }>
}

function recordStepResult(
  accumulator: RenderCheckAccumulator,
  result: StepCheckResult,
  project: string,
  workflow: string,
  mode: string,
  step: string,
): void {
  if (result.kind === 'placeholders') accumulator.failures.push(...result.failures)
  else if (result.kind === 'resolution')
    accumulator.resolutionFailures.push({ project, workflow, mode, step, reason: result.reason })
  else {
    const unresolved = accumulator.unresolvedByProject.get(project) ?? {
      workflows: new Set<string>(),
      facts: new Set<string>(),
    }
    unresolved.workflows.add(workflow)
    for (const fact of result.facts) unresolved.facts.add(fact)
    accumulator.unresolvedByProject.set(project, unresolved)
  }
}

export function checkWorkflowRendering(
  workflows: { slug: string; definition: WorkflowDefinition }[],
  catalogue: StepCatalogueDefinition,
  registeredProjects: Project[],
): WorkflowRenderCheckResult {
  const accumulator: RenderCheckAccumulator = {
    failures: [],
    resolutionFailures: [],
    unresolvedByProject: new Map(),
  }
  const bySlug = new Map(catalogue.steps.map((step) => [step.slug, step]))

  for (const project of registeredProjects) {
    for (const { slug, definition } of workflows) {
      const args = standInArguments(definition, project)
      for (const mode of definition.modes) {
        for (const stepSlug of expandWorkflowSteps(mode.steps, catalogue.sequences ?? [])) {
          const step = bySlug.get(stepSlug)
          if (!step) continue
          recordStepResult(
            accumulator,
            checkStepRendering(project, slug, definition, mode, step, args),
            project.name,
            slug,
            mode.slug,
            stepSlug,
          )
        }
      }
    }
  }

  const unresolvedProjects = [...accumulator.unresolvedByProject.entries()].map(
    ([project, unresolved]): WorkflowFactResolutionFailure => ({
      project,
      workflows: [...unresolved.workflows].sort(),
      facts: [...unresolved.facts].sort(),
    }),
  )
  return {
    failures: accumulator.failures,
    unresolvedProjects,
    resolutionFailures: accumulator.resolutionFailures,
  }
}

export function workflowRenderCheckLines(result: WorkflowRenderCheckResult): string[] {
  return [
    ...result.failures.map(
      (failure) =>
        `${failure.project}  ${failure.workflow}  ${failure.mode}  ${failure.step}  ${failure.field}  ${failure.placeholder}`,
    ),
    ...result.unresolvedProjects.map(
      (failure) =>
        `${failure.project}  ${failure.workflows.join(',')}  project facts could not be resolved: ${failure.facts.join('; ')}`,
    ),
    ...result.resolutionFailures.map(
      (failure) =>
        `${failure.project}  ${failure.workflow}  ${failure.mode}  ${failure.step}  ${failure.reason}`,
    ),
  ]
}

export function renderCheckRefusal(result: WorkflowRenderCheckResult): string | null {
  const lines = result.failures.map(
    (failure) =>
      `- project ${failure.project}, workflow ${failure.workflow}, mode ${failure.mode}, step ${failure.step}, field ${failure.field}, placeholder ${failure.placeholder}`,
  )
  if (!lines.length) return null
  return [
    'production workflow steps do not render for every registered project:',
    ...lines,
    "fix the step body or the project's register entry",
  ].join('\n')
}
