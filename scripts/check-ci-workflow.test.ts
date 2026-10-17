import { expect, test } from 'bun:test'
import { checkCiWorkflow, expectedWorkflowJobNames } from './check-ci-workflow.ts'

test('refuses a workflow with a missing or extra job', () => {
  const workflow = `jobs:\n${expectedWorkflowJobNames()
    .map((job) => {
      if (job === 'hub-ui-stories')
        return `  ${job}:\n    steps:\n      - run: bun run --cwd hub/ui storybook:test\n      - run: bun run --cwd hub/views storybook:test`
      if (job === 'ci') return `  ${job}:\n    needs: [hub-ui-stories]`
      return `  ${job}:\n    runs-on: ubuntu-latest`
    })
    .join('\n')}\n`
  expect(() => checkCiWorkflow(workflow)).not.toThrow()
  expect(() => checkCiWorkflow(workflow.replace('  retrieval:', '  unplanned:'))).toThrow(
    'do not match check plan',
  )
})

test('requires the story job to block the aggregate ci job', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(workflow.replace('    needs: [hub-ui-stories]', '    needs: [static]')),
  ).toThrow('must need hub-ui-stories')
})

test('requires the story job to run the hub-ui story-test script', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(
      workflow.replace('      - run: bun run --cwd hub/ui storybook:test', '      - run: bun test'),
    ),
  ).toThrow('must run the hub-ui story-test script')
})

test('requires the story job to run the hub-views story-test script', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(
      workflow.replace(
        '      - run: bun run --cwd hub/views storybook:test',
        '      - run: bun test',
      ),
    ),
  ).toThrow('must run the hub-views story-test script')
})

function readWorkflowFixture() {
  return `jobs:\n${expectedWorkflowJobNames()
    .map((job) => {
      if (job === 'hub-ui-stories')
        return `  ${job}:\n    steps:\n      - run: bun run --cwd hub/ui storybook:test\n      - run: bun run --cwd hub/views storybook:test`
      if (job === 'ci') return `  ${job}:\n    needs: [hub-ui-stories]`
      return `  ${job}:\n    runs-on: ubuntu-latest`
    })
    .join('\n')}\n`
}
