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
  expect(
    workflowImportLines({
      catalogue: { status: 'created', n: 2 },
      workflowOutcomes: [],
      warnings: [{ step: 'open-pr', source: 'before-pull-request' }],
    })[0],
  ).toBe(
    'warning: step "open-pr" needs fact source "before-pull-request", which this binary does not know; the draft is kept, and promotion refuses it until code that knows "before-pull-request" is installed',
  )
})
