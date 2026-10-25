import { expect, test } from 'bun:test'
import { checkCiWorkflow, expectedWorkflowJobNames } from './check-ci-workflow.ts'

const postgresServiceContainer = `BOTTEGA_TEST_POSTGRES_CONTAINER: \${{ job.services.postgres.id }}`

test('refuses a workflow with a missing or extra job', () => {
  const workflow = `jobs:\n${expectedWorkflowJobNames()
    .map((job) => {
      if (job === 'hub-ui-stories')
        return `  ${job}:\n    steps:\n      - run: bun run --cwd hub/ui storybook:test\n      - run: bun run --cwd hub/views storybook:test`
      if (job === 'orchestrator-hooks') return hooksJobFixture()
      if (job === 'postgres') return postgresJobFixture()
      if (job === 'ci')
        return `  ${job}:\n    needs: [${expectedWorkflowJobNames()
          .filter((name) => name !== 'ci')
          .join(', ')}]`
      return `  ${job}:\n    runs-on: ubuntu-latest`
    })
    .join('\n')}\n`
  expect(() => checkCiWorkflow(workflow)).not.toThrow()
  expect(() => checkCiWorkflow(workflow.replace('  retrieval:', '  unplanned:'))).toThrow(
    'do not match check plan',
  )
})

test('requires every planned job to block the aggregate ci job', () => {
  const workflow = readWorkflowFixture()
  const plannedJobs = expectedWorkflowJobNames().filter((name) => name !== 'ci')
  for (const job of plannedJobs) {
    expect(() =>
      checkCiWorkflow(
        workflow.replace(
          `    needs: [${plannedJobs.join(', ')}]`,
          `    needs: [${plannedJobs.filter((name) => name !== job).join(', ')}]`,
        ),
      ),
    ).toThrow(job)
  }
})

test('pins the Python hook leg', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(workflow.replace("python-version: '3.12'", "python-version: '3.11'")),
  ).toThrow('must use Python 3.12')
  expect(() =>
    checkCiWorkflow(
      workflow.replace('run: $SUITE_COMMAND --only=orchestrator/hooks', 'run: python3 -m unittest'),
    ),
  ).toThrow('must run its check-plan leg')
})

test('pins the real-Postgres leg', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(workflow.replace('image: postgres:18-alpine', 'image: postgres:17-alpine')),
  ).toThrow('must use Postgres 18')
  expect(() =>
    checkCiWorkflow(workflow.replace('bun-version: 1.4.3', 'bun-version: 1.4.2')),
  ).toThrow('must use Bun 1.4.3')
  expect(() =>
    checkCiWorkflow(workflow.replace('run: bun install --silent', 'run: bun install')),
  ).toThrow('must install the workspace')
  expect(() =>
    checkCiWorkflow(
      workflow.replace(postgresServiceContainer, 'BOTTEGA_TEST_POSTGRES_CONTAINER: postgres'),
    ),
  ).toThrow('must pass its service container')
  expect(() =>
    checkCiWorkflow(
      workflow.replace(
        'run: bun run --cwd orchestrator test:postgres --without-live-import',
        'run: bun run --cwd orchestrator test:postgres',
      ),
    ),
  ).toThrow('must run the real-Postgres suite without the live import proof')
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
      if (job === 'postgres') return postgresJobFixture()
      if (job === 'ci')
        return `  ${job}:\n    needs: [${expectedWorkflowJobNames()
          .filter((name) => name !== 'ci')
          .join(', ')}]`
      return `  ${job}:\n    runs-on: ubuntu-latest`
    })
    .join('\n')}\n`
}

function postgresJobFixture() {
  return `  postgres:
    services:
      postgres:
        image: postgres:18-alpine
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.3
      - run: bun install --silent
      - env:
          BOTTEGA_TEST_POSTGRES_CONTAINER: \${{ job.services.postgres.id }}
        run: bun run --cwd orchestrator test:postgres --without-live-import`
}

function hooksJobFixture() {
  return `  orchestrator-hooks:
    steps:
      - uses: actions/setup-python@v6
        with:
          python-version: '3.12'
      - run: $SUITE_COMMAND --only=orchestrator/hooks`
}
