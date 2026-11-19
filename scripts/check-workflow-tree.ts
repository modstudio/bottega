import { fileURLToPath } from 'node:url'
import { validateStepCatalogue } from '../orchestrator/src/workflow/step-catalogue.ts'
import type {
  WorkflowTreeFile,
  WorkflowTreeStore,
} from '../orchestrator/src/workflow/workflow-tree.ts'
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

export function closeInstructionPlaceholderErrors(files: readonly WorkflowTreeFile[]): string[] {
  const errors: string[] = []
  for (const file of files.filter(({ path }) => path.includes('/workflow-steps/'))) {
    for (const [index, line] of file.body.split('\n').entries()) {
      if (!/\bclose\b/i.test(line)) continue
      const references = [
        ...line.matchAll(/--artifact\s+task:([^\s`,.;]+)/g),
        ...line.matchAll(/--task\s+([^\s`,.;]+)/g),
      ]
      for (const match of references) {
        if (match[1] !== '{{key}}')
          errors.push(
            `${file.path}:${index + 1}: close instruction must name the cursor key as {{key}}, not ${match[1]}`,
          )
      }
    }
  }
  return errors
}

if (import.meta.main) {
  const started = performance.now()
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  try {
    const files = collectWorkflowTree(root)
    const errors = [
      ...closeInstructionPlaceholderErrors(files),
      ...workflowTreeValidationErrors(parseWorkflowTree(files)),
    ]
    for (const error of errors) console.error(error)
    console.log(`workflow tree: checked in ${(performance.now() - started).toFixed(1)} ms`)
    if (errors.length) process.exitCode = 1
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exitCode = 1
  }
}
