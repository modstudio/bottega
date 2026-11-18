import { expect, test } from 'bun:test'
import { nextWorkflowStepInputSchema } from './mcp-workflow-input.ts'

const input = { slug: 'flow', project: 'fixture', note: 'closed' }

test('next workflow step accepts one artifact or a non-empty artifact list', () => {
  expect(nextWorkflowStepInputSchema.parse({ ...input, artifact: 'task:DEV-1' }).artifact).toBe(
    'task:DEV-1',
  )
  expect(
    nextWorkflowStepInputSchema.parse({
      ...input,
      artifact: ['task:DEV-1', 'doc:project/fixture/note'],
    }).artifact,
  ).toEqual(['task:DEV-1', 'doc:project/fixture/note'])
  expect(nextWorkflowStepInputSchema.safeParse({ ...input, artifact: [] }).success).toBeFalse()
})
