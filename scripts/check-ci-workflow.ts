import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, CI_ONLY_JOBS } from './check-plan.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const postgresServiceContainer = `BOTTEGA_TEST_POSTGRES_CONTAINER: \${{ job.services.postgres.id }}`

function workflowJobNames(source: string): string[] {
  const jobsStart = source.split('\n').indexOf('jobs:')
  if (jobsStart < 0) throw new Error('CI workflow has no jobs mapping')
  return source
    .split('\n')
    .slice(jobsStart + 1)
    .flatMap((line) => line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/)?.[1] ?? [])
}

function workflowJob(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  if (start < 0) throw new Error(`CI workflow has no ${name} job`)
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(line),
  )
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

function aggregateNeeds(source: string): string[] {
  const job = workflowJob(source, 'ci')
  const inline = job.match(/^ {4}needs:\s*\[([^\]]*)\]\s*$/m)
  if (inline)
    return inline[1]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  const lines = job.split('\n')
  const start = lines.findIndex((line) => line === '    needs:')
  if (start < 0) return []
  return lines
    .slice(start + 1)
    .flatMap((line) => line.match(/^ {6}-\s+([a-z][a-z0-9-]*)\s*$/)?.[1] ?? [])
}

export function expectedWorkflowJobNames(): string[] {
  return [
    'secrets',
    'static',
    ...CHECK_LEGS.map((leg) => leg.ciJob),
    ...CI_ONLY_JOBS,
    'root',
    'ci',
  ].sort()
}

export function checkCiWorkflow(source: string): void {
  const actual = workflowJobNames(source).sort()
  const expected = expectedWorkflowJobNames()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `CI jobs do not match check plan: expected ${expected.join(', ')}; got ${actual.join(', ')}`,
    )
  }
  if (!aggregateNeeds(source).includes('hub-ui-stories'))
    throw new Error('CI aggregate job must need hub-ui-stories')
  if (!aggregateNeeds(source).includes('orchestrator-hooks'))
    throw new Error('CI aggregate job must need orchestrator-hooks')
  if (!aggregateNeeds(source).includes('postgres'))
    throw new Error('CI aggregate job must need postgres')
  if (!workflowJob(source, 'hub-ui-stories').includes('bun run --cwd hub/ui storybook:test'))
    throw new Error('hub-ui-stories job must run the hub-ui story-test script')
  if (!workflowJob(source, 'hub-ui-stories').includes('bun run --cwd hub/views storybook:test'))
    throw new Error('hub-ui-stories job must run the hub-views story-test script')
  const hooks = workflowJob(source, 'orchestrator-hooks')
  if (!hooks.includes('uses: actions/setup-python@v6') || !hooks.includes("python-version: '3.12'"))
    throw new Error('orchestrator-hooks job must use Python 3.12')
  if (!hooks.includes('run: $SUITE_COMMAND --only=orchestrator/hooks'))
    throw new Error('orchestrator-hooks job must run its check-plan leg')
  const postgres = workflowJob(source, 'postgres')
  if (!postgres.includes('image: postgres:18-alpine'))
    throw new Error('postgres job must use Postgres 18')
  if (!postgres.includes('uses: oven-sh/setup-bun@v2') || !postgres.includes('bun-version: 1.4.3'))
    throw new Error('postgres job must use Bun 1.4.3')
  if (!postgres.includes('run: bun install --silent'))
    throw new Error('postgres job must install the workspace')
  if (!postgres.includes(postgresServiceContainer))
    throw new Error('postgres job must pass its service container to the real-Postgres suite')
  if (!postgres.includes('run: bun run --cwd orchestrator test:postgres --without-live-import'))
    throw new Error('postgres job must run the real-Postgres suite without the live import proof')
}

if (import.meta.main) {
  checkCiWorkflow(readFileSync(`${root}.github/workflows/ci.yml`, 'utf8'))
  console.log('CI workflow covers every check-plan leg and the root test batch')
}
