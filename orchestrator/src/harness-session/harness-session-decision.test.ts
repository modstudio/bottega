import { expect, test } from 'bun:test'
import {
  type HarnessSessionPublication,
  harnessSessionDisposition,
  isClaudeHarness,
  unpublishedHarnessProcesses,
} from './harness-session-decision.ts'

const publication = (pid: number, startTime: string): HarnessSessionPublication => ({
  identity: { pid, startTime },
  session: `session-${pid}`,
  harness: 'claude-code',
  source: 'startup',
  published_at: new Date(0).toISOString(),
})

test('maps process identity observations to storage dispositions', () => {
  expect(harnessSessionDisposition('dead')).toBe('reap')
  expect(harnessSessionDisposition('reused')).toBe('reap')
  expect(harnessSessionDisposition('live')).toBe('keep')
  expect(harnessSessionDisposition('unknown')).toBe('unknown')
})

test('recognizes only a claude basename in the first command token', () => {
  expect(isClaudeHarness({ command: '/opt/bin/claude --resume' })).toBe(true)
  expect(isClaudeHarness({ command: 'claude --resume' })).toBe(true)
  expect(isClaudeHarness({ command: '/opt/bin/claude-code --resume' })).toBe(false)
  expect(isClaudeHarness({ command: 'bun /opt/bin/claude' })).toBe(false)
})

test('measures Claude harnesses without a kept publication by pid', () => {
  const processes = [
    { pid: 10, command: '/opt/bin/claude --resume' },
    { pid: 11, command: 'claude --continue' },
    { pid: 12, command: 'bun test' },
  ]
  const publications = [publication(10, 'published-start')]

  expect(unpublishedHarnessProcesses(processes, publications)).toEqual([
    { pid: 11, command: 'claude --continue' },
  ])
})
