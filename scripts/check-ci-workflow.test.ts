import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  agreedPlaywrightDependencyPin,
  checkCiWorkflow,
  checkReleaseWorkflow,
  expectedWorkflowJobNames,
  suiteRunLine,
} from './check-ci-workflow.ts'
import { CI_ONLY_SUITES } from './check-plan.ts'

const postgresServiceContainer = `BOTTEGA_TEST_POSTGRES_CONTAINER: \${{ job.services.postgres.id }}`
const processSuite = CI_ONLY_SUITES[0]!
const playwrightPin = (
  JSON.parse(readFileSync(new URL('../hub/web/package.json', import.meta.url), 'utf8')) as {
    devDependencies: Record<string, string>
  }
).devDependencies.playwright

test('refuses a workflow with a missing or extra job', () => {
  const workflow = `jobs:\n${expectedWorkflowJobNames()
    .map((job) => {
      if (job === 'hub-ui-stories')
        return `  ${job}:\n    container:\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble\n    steps:\n      - name: Trust the workspace\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - name: Install Bun\n        run: npm install --global "bun@$(cat .bun-version)"\n      - run: bun run --cwd hub/ui storybook:test\n      - run: bun run --cwd hub/views storybook:test`
      if (job === 'hub-web-smoke')
        return `  ${job}:\n    container:\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble\n    steps:\n      - name: Trust the workspace\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - name: Install Bun\n        run: npm install --global "bun@$(cat .bun-version)"`
      if (job === 'orchestrator-hooks') return hooksJobFixture()
      if (job === processSuite.job) return processHooksJobFixture()
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

test('pins the declared CI-only process suite job', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(
      workflow.replace(`run: ${suiteRunLine(processSuite.argv)}`, 'run: python3 -m unittest'),
    ),
  ).toThrow(`the ${processSuite.job} job must run its declared suite`)
})

test('pins the real-Postgres leg', () => {
  const workflow = readWorkflowFixture()
  expect(() =>
    checkCiWorkflow(workflow.replace('image: postgres:18-alpine', 'image: postgres:17-alpine')),
  ).toThrow('must use Postgres 18')
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

test('refuses a mismatched Playwright image tag', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        '    runs-on: ubuntu-latest',
        '    runs-on: ubuntu-latest\n    container:\n      image: mcr.microsoft.com/playwright:v1.63.0-noble',
      ),
    ),
  ).toThrow(`set the image tag to v${playwrightPin}-noble`)
})

test('refuses a suffix-less mismatched Playwright image tag', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        `mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
        'mcr.microsoft.com/playwright:v1.60.0',
      ),
    ),
  ).toThrow(`set the image tag to v${playwrightPin}`)
})

test('accepts Playwright container options before the image', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        `    container:\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
        `    container:\n      options: --ipc=host\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
      ),
    ),
  ).not.toThrow()
})

test('requires the web smoke job to run in the pinned Playwright image', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        `  hub-web-smoke:\n    container:\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
        '  hub-web-smoke:\n    runs-on: ubuntu-latest',
      ),
    ),
  ).toThrow(
    `job hub-web-smoke must run in the pinned Playwright image; add container: image: mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
  )
})

test('requires the story job to run in the pinned Playwright image', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        `  hub-ui-stories:\n    container:\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
        '  hub-ui-stories:\n    runs-on: ubuntu-latest',
      ),
    ),
  ).toThrow(
    `job hub-ui-stories must run in the pinned Playwright image; add container: image: mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
  )
})

test('validates Playwright dependency pins', () => {
  expect(() =>
    agreedPlaywrightDependencyPin([
      { file: 'hub/ui/package.json', pin: undefined },
      { file: 'hub/views/package.json', pin: '1.64.1' },
      { file: 'hub/web/package.json', pin: '1.64.1' },
    ]),
  ).toThrow('hub/ui/package.json must pin the playwright devDependency')
  expect(() =>
    agreedPlaywrightDependencyPin([
      { file: 'hub/ui/package.json', pin: '^1.64.1' },
      { file: 'hub/views/package.json', pin: '1.64.1' },
      { file: 'hub/web/package.json', pin: '1.64.1' },
    ]),
  ).toThrow(
    'hub/ui/package.json pins playwright ^1.64.1; pin the exact version the Playwright image tag carries',
  )
  expect(() =>
    agreedPlaywrightDependencyPin([
      { file: 'hub/ui/package.json', pin: '1.64.1' },
      { file: 'hub/views/package.json', pin: '1.63.0' },
      { file: 'hub/web/package.json', pin: '1.64.1' },
    ]),
  ).toThrow('set all three package.json playwright pins to the same version')
})

test('refuses a playwright install run command', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        '    runs-on: ubuntu-latest',
        '    runs-on: ubuntu-latest\n    steps:\n      - run: bunx playwright install chromium',
      ),
    ),
  ).toThrow('run the job in the pinned Playwright image instead')
})

test('refuses setup-bun in a Playwright browser job', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        '      - name: Install Bun\n        run: npm install --global "bun@$(cat .bun-version)"',
        '      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version-file: .bun-version',
      ),
    ),
  ).toThrow('job hub-ui-stories must not use oven-sh/setup-bun')
})

test('refuses a literal npm Bun version in a Playwright browser job', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        'npm install --global "bun@$(cat .bun-version)"',
        'npm install --global "bun@1.4.4"',
      ),
    ),
  ).toThrow('job hub-ui-stories must install Bun from .bun-version')
})

test('requires Playwright browser jobs to trust the workspace', () => {
  expect(() =>
    checkCiWorkflow(
      readWorkflowFixture().replace(
        '      - name: Trust the workspace\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n',
        '',
      ),
    ),
  ).toThrow(
    'job hub-ui-stories must trust the workspace because the Playwright container runs as root over a workspace owned by the runner user, so git refuses it',
  )
})

test('accepts the real CI workflow', () => {
  expect(() =>
    checkCiWorkflow(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')),
  ).not.toThrow()
})

test('refuses a release upload outside the release publisher', () => {
  expect(() =>
    checkReleaseWorkflow(releaseWorkflowFixture(undefined, 'gh release upload "$TAG" artifact')),
  ).toThrow('publish every asset through "bun run release:publish"')
})

test('refuses a release upload in a block scalar outside the release publisher', () => {
  expect(() =>
    checkReleaseWorkflow(
      releaseWorkflowFixture(undefined, '|\n          gh release upload "$TAG" artifact'),
    ),
  ).toThrow('publish every asset through "bun run release:publish"')
})

test('refuses release creation outside the release publisher', () => {
  expect(() =>
    checkReleaseWorkflow(releaseWorkflowFixture(undefined, 'gh release create "$TAG"')),
  ).toThrow('found "gh release create"')
})

function releaseWorkflowFixture(
  pin: string | null = 'bun-version-file: .bun-version',
  command?: string,
) {
  return `name: release
on:
  push:
    tags:
      - 'v*'
jobs:
  release:
    runs-on: macos-15
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          ${pin ?? 'cache: true'}
${command ? `      - run: ${command}\n` : ''}
`
}

function readWorkflowFixture() {
  return `jobs:\n${expectedWorkflowJobNames()
    .map((job) => {
      if (job === 'hub-ui-stories')
        return `  ${job}:\n    container:\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble\n    steps:\n      - name: Trust the workspace\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - name: Install Bun\n        run: npm install --global "bun@$(cat .bun-version)"\n      - run: bun run --cwd hub/ui storybook:test\n      - run: bun run --cwd hub/views storybook:test`
      if (job === 'hub-web-smoke')
        return `  ${job}:\n    container:\n      image: mcr.microsoft.com/playwright:v${playwrightPin}-noble\n    steps:\n      - name: Trust the workspace\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - name: Install Bun\n        run: npm install --global "bun@$(cat .bun-version)"`
      if (job === 'orchestrator-hooks') return hooksJobFixture()
      if (job === processSuite.job) return processHooksJobFixture()
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
          bun-version-file: .bun-version
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

function processHooksJobFixture() {
  return `  ${processSuite.job}:
    steps:
      - uses: actions/setup-python@v6
        with:
          python-version: '3.12'
      - run: ${suiteRunLine(processSuite.argv)}`
}
