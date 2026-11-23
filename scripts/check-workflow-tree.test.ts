import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseWorkflowTree } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import { workflowNamingErrors, workflowTreeValidationErrors } from './check-workflow-tree.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

test('rejects an unknown fact source', () => {
  const tree = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  tree.steps[0] = { ...tree.steps[0]!, needs: ['unknown-fact-source'] as never }
  expect(workflowTreeValidationErrors(tree)).toContain(
    `catalogue: step "${tree.steps[0]!.slug}" has invalid injection source "unknown-fact-source"`,
  )
})

test('naming guard covers step bodies, titles and rendered guidance without flagging the flag', () => {
  const tree = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  const changed = structuredClone(tree)
  changed.steps[0] = {
    ...changed.steps[0]!,
    title: 'The operator approves',
    body: 'Ask the operator, then use --from-operator.',
  }
  const findings = workflowNamingErrors(
    changed,
    new Map(),
    'Return the operator ruling with --from-operator.',
  )
  expect(findings).toHaveLength(3)
  expect(findings.some((finding) => finding.includes('workflow-render.ts'))).toBe(true)
  expect(workflowNamingErrors(tree)).toEqual([])
})
