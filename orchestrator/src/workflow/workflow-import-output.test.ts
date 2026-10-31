import { expect, test } from 'bun:test'
import { workflowImportLines } from './workflow-import-output.ts'

test('workflow import reports created and unchanged drafts per item', () => {
  expect(
    workflowImportLines({
      catalogue: { status: 'created', n: 2 },
      workflowOutcomes: [{ slug: 'ship-task', status: 'no change' }],
    }),
  ).toEqual(['catalogue: created draft 2', 'ship-task: no change'])
})

test('workflow import warns that an unknown fact source remains draft-only', () => {
  const warning = workflowImportLines({
    catalogue: { status: 'created', n: 2 },
    workflowOutcomes: [],
    warnings: [{ step: 'open-pr', source: 'before-pull-request' }],
  })[0]!
  expect(warning).toContain('step "open-pr"')
  expect(warning).toContain('fact source "before-pull-request"')
  expect(warning).toContain('promotion refuses it')
})
