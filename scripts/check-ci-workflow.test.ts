import { expect, test } from 'bun:test'
import { checkCiWorkflow, expectedWorkflowJobNames } from './check-ci-workflow.ts'

test('refuses a workflow with a missing or extra job', () => {
  const workflow = `jobs:\n${expectedWorkflowJobNames()
    .map((job) => `  ${job}:\n    runs-on: ubuntu-latest`)
    .join('\n')}\n`
  expect(() => checkCiWorkflow(workflow)).not.toThrow()
  expect(() => checkCiWorkflow(workflow.replace('  retrieval:', '  unplanned:'))).toThrow(
    'do not match check plan',
  )
})
