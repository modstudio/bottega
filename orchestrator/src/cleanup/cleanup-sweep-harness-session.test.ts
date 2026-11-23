import { expect, test } from 'bun:test'
import type { HarnessSessionPublication } from '../harness-session/harness-session-decision.ts'
import type { ProcessFact } from '../resources/process-inventory.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { sweepHarnessSessionPublications } from './cleanup-sweep-harness-session.ts'

const publication: HarnessSessionPublication = {
  identity: { pid: 10, startTime: 'published-start' },
  session: 'published-session',
  harness: 'claude-code',
  source: 'startup',
  published_at: new Date(0).toISOString(),
}

const processFact = (pid: number, command: string): ProcessFact => ({
  pid,
  ppid: 1,
  pgid: pid,
  cpu: 0,
  command,
  ageSeconds: 1,
  startTime: `start-${pid}`,
  cwd: null,
  cwdVerified: false,
})

const recordingPresentation = () => {
  const logs: string[] = []
  const errors: string[] = []
  const presentation: CleanupPresentation = {
    log: (...values) => logs.push(values.join(' ')),
    error: (...values) => errors.push(values.join(' ')),
    setExitCode: () => {},
    keptBranchLine: () => '',
  }
  return { logs, errors, presentation }
}

test('reports reaping and the unpublished Claude harness count from one publication set', () => {
  const observed = recordingPresentation()
  let receivedDryRun: boolean | undefined

  const failed = sweepHarnessSessionPublications(true, observed.presentation, {
    reap: ({ dryRun } = {}) => {
      receivedDryRun = dryRun
      return { reaped: 2, publications: [publication] }
    },
    inventory: () => ({
      facts: [
        processFact(10, '/opt/bin/claude --resume'),
        processFact(11, 'claude --continue'),
        processFact(12, 'bun test'),
      ],
      error: null,
    }),
  })

  expect(failed).toBe(false)
  expect(receivedDryRun).toBe(true)
  expect(observed.logs).toEqual([
    'harness session publications reaped: 2',
    'harness processes without a published session: 1',
    '  11 claude --continue',
  ])
  expect(observed.errors).toEqual([])
})

test('reports a harness-session maintenance failure instead of throwing', () => {
  const observed = recordingPresentation()

  const failed = sweepHarnessSessionPublications(false, observed.presentation, {
    reap: () => {
      throw new Error('publication directory denied')
    },
  })

  expect(failed).toBe(true)
  expect(observed.errors).toEqual([
    'harness session publication sweep failed: publication directory denied',
  ])
})
