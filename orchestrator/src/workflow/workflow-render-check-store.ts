// concern: workflows
/** Gathers each project's resolved workflow catalogue and composed workflow slugs. */
import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'
import { TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { selectedStepCatalogue } from './step-catalogue.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
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
): Promise<ResolvedWorkflowRenderCheckResult> {
  return composedWorkflowsByProject(d, registeredProjects).then((composedWorkflows) => {
    const result: ResolvedWorkflowRenderCheckResult = {
      failures: [],
      unresolvedProjects: [],
      notApplicable: [],
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
          composedWorkflows,
        )
        result.failures.push(...checked.failures)
        result.unresolvedProjects.push(...checked.unresolvedProjects)
        result.notApplicable.push(...checked.notApplicable)
        result.resolutionFailures.push(...checked.resolutionFailures)
      }
    }
    return result
  })
}

function composedWorkflowsByProject(
  d: Database,
  registeredProjects: Project[],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const store = taskFlowReadStore(d)
  return Promise.all(
    registeredProjects.map(
      async (project) =>
        [
          project.name,
          new Set(
            (await store.listStages({ project: project.name, states: TASK_FLOW_STAGE_STATES })).map(
              ({ workflow_slug }) => workflow_slug,
            ),
          ),
        ] as const,
    ),
  ).then((composedWorkflows) => new Map(composedWorkflows))
}
