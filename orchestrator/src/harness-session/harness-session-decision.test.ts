import { expect, test } from 'bun:test'
import {
  type HarnessSessionPublication,
  unpublishedHarnessProcesses,
} from './harness-session-decision.ts'

const publication = (pid: number, startTime: string): HarnessSessionPublication => ({
  identity: { pid, startTime },
  session: `session-${pid}`,
  harness: 'claude-code',
  source: 'startup',
  published_at: new Date(0).toISOString(),
})

test('measures unpublished harnesses by pid and process birth', () => {
  const processes = [
    { pid: 10, startTime: 'published-start' },
    { pid: 11, startTime: 'unpublished-start' },
    { pid: 12, startTime: 'reused-start' },
  ]
  const publications = [publication(10, 'published-start'), publication(12, 'old-start')]

  expect(unpublishedHarnessProcesses(processes, publications)).toEqual([
    { pid: 11, startTime: 'unpublished-start' },
    { pid: 12, startTime: 'reused-start' },
  ])
})
