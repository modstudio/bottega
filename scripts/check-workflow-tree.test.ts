import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseWorkflowTree } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import { workflowTreeValidationErrors } from './check-workflow-tree.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

test('rejects an unknown fact source', () => {
  const tree = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  tree.steps[0] = { ...tree.steps[0]!, needs: ['unknown-fact-source'] as never }
  expect(workflowTreeValidationErrors(tree)).toContain(
    `catalogue: step "${tree.steps[0]!.slug}" has invalid injection source "unknown-fact-source"`,
  )
})

test('the checkout workflow tree validates with checkout code', () => {
  expect(
    workflowTreeValidationErrors(parseWorkflowTree(collectWorkflowTree(repositoryRoot))),
  ).toEqual([])
})
