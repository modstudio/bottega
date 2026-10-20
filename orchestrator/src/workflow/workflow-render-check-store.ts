// concern: workflows
/** Gathers each project's resolved workflow catalogue for the pure render check. */
import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'
import { selectedStepCatalogue } from './step-catalogue.ts'
import {
  checkWorkflowRendering,
  type WorkflowRenderCheckResult,
  workflowRenderCheckLines,
} from './workflow-render-check.ts'
import { resolvedProductionWorkflows } from './workflows.ts'

export type ResolvedWorkflowRenderCheckResult = WorkflowRenderCheckResult & {
  checkedSpaces: { project: string; spaces: (string | null)[] }[]
}

export function resolvedWorkflowRenderCheckLines(
  result: ResolvedWorkflowRenderCheckResult,
): string[] {
  return [
    ...result.checkedSpaces.map(
      ({ project, spaces }) =>
        `${project}  checked workflow spaces: ${spaces.map((space) => space ?? 'local').join(',')}`,
    ),
    ...workflowRenderCheckLines(result),
  ]
}

export function checkResolvedWorkflowRendering(
  d: Database,
  registeredProjects: Project[],
): ResolvedWorkflowRenderCheckResult {
  const result: ResolvedWorkflowRenderCheckResult = {
    failures: [],
    unresolvedProjects: [],
    resolutionFailures: [],
    checkedSpaces: [],
  }
  for (const project of registeredProjects) {
    const bySpace = Map.groupBy(
      resolvedProductionWorkflows(project.name, d),
      ({ spaceId }) => spaceId ?? 'local',
    )
    result.checkedSpaces.push({
      project: project.name,
      spaces: [...bySpace.values()].map((workflows) => workflows[0]!.spaceId),
    })
    for (const workflows of bySpace.values()) {
      const spaceId = workflows[0]!.spaceId
      const checked = checkWorkflowRendering(
        workflows.map(({ slug, definition }) => ({ slug, definition })),
        selectedStepCatalogue(undefined, d, spaceId).definition,
        [project],
      )
      result.failures.push(...checked.failures)
      result.unresolvedProjects.push(...checked.unresolvedProjects)
      result.resolutionFailures.push(...checked.resolutionFailures)
    }
  }
  return result
}
