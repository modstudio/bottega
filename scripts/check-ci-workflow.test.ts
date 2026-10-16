import { expect, test } from 'bun:test'
import { checkCiWorkflow, expectedWorkflowJobNames } from './check-ci-workflow.ts'
import { CHECK_LEGS, CI_ONLY_JOBS } from './check-plan.ts'

test('the expected CI job set is derived from every manifest leg plus the root batch', () => {
  expect(expectedWorkflowJobNames()).toEqual(
    [
      'secrets',
      'static',
      ...CHECK_LEGS.map((leg) => leg.ciJob),
      ...CI_ONLY_JOBS,
      'root',
      'ci',
    ].sort(),
  )
})

test('refuses a workflow with a missing or extra job', () => {
  const workflow = `jobs:\n${expectedWorkflowJobNames()
    .map((job) => `  ${job}:\n    runs-on: ubuntu-latest`)
    .join('\n')}\n`
  expect(() => checkCiWorkflow(workflow)).not.toThrow()
  expect(() => checkCiWorkflow(workflow.replace('  retrieval:', '  unplanned:'))).toThrow(
    'do not match check plan',
  )
})
