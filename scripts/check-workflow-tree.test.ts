import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseWorkflowTree } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import {
  closeInstructionPlaceholderErrors,
  workflowTreeValidationErrors,
} from './check-workflow-tree.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

test('rejects an unknown fact source', () => {
  const tree = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  tree.steps[0] = { ...tree.steps[0]!, needs: ['unknown-fact-source'] as never }
  expect(workflowTreeValidationErrors(tree)).toContain(
    `catalogue: step "${tree.steps[0]!.slug}" has invalid injection source "unknown-fact-source"`,
  )
})

test('rejects a placeholder in a task close instruction', () => {
  expect(
    closeInstructionPlaceholderErrors([
      {
        path: '.agents/workflow-steps/write.md',
        body: 'Close this step with `--artifact task:<KEY>`.',
      },
    ]),
  ).toEqual([
    '.agents/workflow-steps/write.md:1: close instruction must name the cursor key as {{key}}, not <KEY>',
  ])
})
