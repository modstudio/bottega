import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, CI_ONLY_JOBS } from './check-plan.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function workflowJobNames(source: string): string[] {
  const jobsStart = source.split('\n').indexOf('jobs:')
  if (jobsStart < 0) throw new Error('CI workflow has no jobs mapping')
  return source
    .split('\n')
    .slice(jobsStart + 1)
    .flatMap((line) => line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/)?.[1] ?? [])
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
}

if (import.meta.main) {
  checkCiWorkflow(readFileSync(`${root}.github/workflows/ci.yml`, 'utf8'))
  console.log('CI workflow covers every check-plan leg and the root test batch')
}
