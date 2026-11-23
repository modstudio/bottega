import { expect, test } from 'bun:test'
import {
  HARNESS_SESSION_TEMP_GRACE_MS,
  isClaudeHarness,
  type ObservedHarnessSessionPublication,
  temporaryPublicationDisposition,
  unpublishedHarnessProcesses,
} from './harness-session-decision.ts'

const publication = (
  pid: number,
  startTime: string,
  observedIdentity: ObservedHarnessSessionPublication['observedIdentity'] = 'live',
): ObservedHarnessSessionPublication => ({
  identity: { pid, startTime },
  session: `session-${pid}`,
  harness: 'claude-code',
  source: 'startup',
  published_at: new Date(0).toISOString(),
  observedIdentity,
})

test('classifies temporary publication entries by name and age', () => {
  const temporary = '.42-start.json.00000000-0000-4000-8000-000000000001.tmp'
  const now = 1_000_000
  expect(
    temporaryPublicationDisposition(temporary, now - HARNESS_SESSION_TEMP_GRACE_MS - 1, now),
  ).toBe('reap')
  expect(temporaryPublicationDisposition(temporary, now - HARNESS_SESSION_TEMP_GRACE_MS, now)).toBe(
    'keep',
  )
  expect(temporaryPublicationDisposition('42-start.json', 0, now)).toBe('ignore')
})

test('recognizes only a claude basename in the first command token', () => {
  expect(isClaudeHarness({ command: '/opt/bin/claude --resume' })).toBe(true)
  expect(isClaudeHarness({ command: 'claude --resume' })).toBe(true)
  expect(isClaudeHarness({ command: '/opt/bin/claude-code --resume' })).toBe(false)
  expect(isClaudeHarness({ command: 'bun /opt/bin/claude' })).toBe(false)
})

test('measures Claude harnesses without a live publication for the same pid and start time', () => {
  const processes = [
    { pid: 10, startTime: 'current-10', command: '/opt/bin/claude --resume' },
    { pid: 11, startTime: 'current-11', command: 'claude --continue' },
    { pid: 12, startTime: 'current-12', command: 'bun test' },
  ]
  const publications = [publication(10, 'current-10')]

  expect(unpublishedHarnessProcesses(processes, publications)).toEqual([
    { pid: 11, startTime: 'current-11', command: 'claude --continue' },
  ])
})

test('a publication from an earlier process with the same pid does not hide the live process', () => {
  const process = { pid: 10, startTime: 'current-start', command: 'claude --continue' }

  expect(unpublishedHarnessProcesses([process], [publication(10, 'earlier-start')])).toEqual([
    process,
  ])
})

test('an unknown publication does not hide the live process', () => {
  const process = { pid: 10, startTime: 'current-start', command: 'claude --continue' }

  expect(
    unpublishedHarnessProcesses([process], [publication(10, 'current-start', 'unknown')]),
  ).toEqual([process])
})
