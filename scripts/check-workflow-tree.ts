import { fileURLToPath } from 'node:url'
import { validateStepCatalogue } from '../orchestrator/src/workflow/step-catalogue.ts'
import type { WorkflowTreeStore } from '../orchestrator/src/workflow/workflow-tree.ts'
import { parseWorkflowTree } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import { validateWorkflowDefinition } from '../orchestrator/src/workflow/workflows.ts'

export function workflowTreeValidationErrors(tree: WorkflowTreeStore): string[] {
  const catalogue = { steps: tree.steps, sequences: tree.sequences }
  return [
    ...validateStepCatalogue(catalogue).map((error) => `catalogue: ${error}`),
    ...tree.workflows.flatMap(({ slug, definition }) =>
      validateWorkflowDefinition(definition, undefined, catalogue).map(
        (error) => `workflow "${slug}": ${error}`,
      ),
    ),
  ]
}

if (import.meta.main) {
  const started = performance.now()
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  try {
    const errors = workflowTreeValidationErrors(parseWorkflowTree(collectWorkflowTree(root)))
    for (const error of errors) console.error(error)
    console.log(`workflow tree: checked in ${(performance.now() - started).toFixed(1)} ms`)
    if (errors.length) process.exitCode = 1
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exitCode = 1
  }
}
