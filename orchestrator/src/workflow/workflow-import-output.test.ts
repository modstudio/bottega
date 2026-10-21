import { expect, test } from 'bun:test'
import { workflowImportLines } from './workflow-commands.ts'

test('workflow import reports created and unchanged drafts per item', () => {
  expect(
    workflowImportLines({
      steps: [],
      sequences: ['review'],
      workflows: [],
      catalogue: { status: 'created', n: 2 },
      workflowOutcomes: [{ slug: 'ship-task', status: 'no change' }],
    }),
  ).toEqual(['catalogue: created draft 2', 'ship-task: no change'])
})
