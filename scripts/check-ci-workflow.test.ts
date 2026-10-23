import { expect, test } from 'bun:test'
import { checkCiWorkflow, expectedWorkflowJobNames } from './check-ci-workflow.ts'

test('refuses a workflow with a missing or extra job', () => {
  const workflow = `jobs:\n${expectedWorkflowJobNames()
    .map((job) => {
      if (job === 'hub-ui-stories')
        return `  ${job}:\n    steps:\n      - run: bun run --cwd hub/ui storybook:test\n      - run: bun run --cwd hub/views storybook:test`
      if (job === 'orchestrator-hooks') return hooksJobFixture()
      if (job === 'ci') return `  ${job}:\n    needs: [hub-ui-stories, orchestrator-hooks]`
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
    checkCiWorkflow(
      workflow.replace(
        '    needs: [hub-ui-stories, orchestrator-hooks]',
        '    needs: [orchestrator-hooks]',
      ),
    ),
  ).toThrow('must need hub-ui-stories')
})

test('pins the Python hook leg and makes it block aggregate CI', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(
      workflow.replace(
        '    needs: [hub-ui-stories, orchestrator-hooks]',
        '    needs: [hub-ui-stories]',
      ),
    ),
  ).toThrow('must need orchestrator-hooks')
  expect(() =>
    checkCiWorkflow(workflow.replace("python-version: '3.12'", "python-version: '3.11'")),
  ).toThrow('must use Python 3.12')
  expect(() =>
    checkCiWorkflow(
      workflow.replace('run: $SUITE_COMMAND --only=orchestrator/hooks', 'run: python3 -m unittest'),
    ),
  ).toThrow('must run its check-plan leg')
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
      if (job === 'orchestrator-hooks') return hooksJobFixture()
      if (job === 'ci') return `  ${job}:\n    needs: [hub-ui-stories, orchestrator-hooks]`
      return `  ${job}:\n    runs-on: ubuntu-latest`
    })
    .join('\n')}\n`
}

function hooksJobFixture() {
  return `  orchestrator-hooks:
    steps:
      - uses: actions/setup-python@v6
        with:
          python-version: '3.12'
      - run: $SUITE_COMMAND --only=orchestrator/hooks`
}
