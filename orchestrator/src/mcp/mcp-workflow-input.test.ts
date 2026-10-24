import { expect, test } from 'bun:test'
import { nextWorkflowStepInputSchema } from './mcp-workflow-input.ts'

const required = { slug: 'ship', project: 'fixture', note: 'done' }

test('next_workflow_step accepts a gate number or UUID', () => {
  const recordId = '01990000-0000-7000-8000-000000001699'
  expect(nextWorkflowStepInputSchema.parse({ ...required, gate: 7 }).gate).toBe(7)
  expect(nextWorkflowStepInputSchema.parse({ ...required, gate: recordId }).gate).toBe(recordId)
  expect(nextWorkflowStepInputSchema.safeParse({ ...required, gate: '7' }).success).toBe(false)
})
