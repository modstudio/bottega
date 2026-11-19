// concern: workflow autonomy coverage
/** Refuses partial autonomy resolutions before a workflow step can dereference them. */

import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import type { WorkflowAutonomyResolution } from './autonomy.ts'
import { workflowComposeCommand, workflowCursorResetRemedy } from './workflow-cursor-format.ts'

export function assertAutonomyCoverage(
  workflow: string,
  project: string,
  mode: string | undefined,
  args: Record<string, string>,
  steps: readonly { slug: string }[],
  autonomy: WorkflowAutonomyResolution,
): void {
  const uncovered = steps
    .map((step) => step.slug)
    .filter((step) => autonomy.steps[step] === undefined)
  if (!uncovered.length) return
  const remedy =
    'cursor' in autonomy
      ? workflowCursorResetRemedy(autonomy.cursor, project)
      : workflowComposeCommand(workflow, project, mode ?? '<mode>', args)
  throw new Error(
    renderRefusal(
      refusal(
        `workflow "${workflow}" autonomy resolution has no entry for steps: ${uncovered.join(', ')}`,
        { kind: 'edit', text: remedy },
      ),
    ),
  )
}
