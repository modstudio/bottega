import { expect, test } from 'bun:test'
import {
  captureHarnessMcpFacts,
  mcpAddArgv,
  mcpRemoveArgv,
  readMcpRegistration,
  SETUP_COMMAND_TIMEOUT_MS,
  type SetupCommandResult,
} from './setup-mcp.ts'

const result = (stdout: string, exitCode = 0, stderr = ''): SetupCommandResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
  error: null,
})

test('captures absent and registered CLI read-backs through the bounded runner', () => {
  const calls: { argv: string[]; timeoutMs: number }[] = []
  const runner = (argv: string[], timeoutMs: number) => {
    calls.push({ argv, timeoutMs })
    if (argv.includes('missing'))
      return result('', 1, "Error: No MCP server named 'missing' found.")
    return result(
      JSON.stringify({ transport: { type: 'stdio', command: '/bin/orch', args: ['mcp'] } }),
    )
  }
  expect(readMcpRegistration('codex', '/bin/codex', 'orch', runner)).toEqual({
    status: 'registered',
    command: '/bin/orch',
    args: ['mcp'],
  })
  expect(readMcpRegistration('codex', '/bin/codex', 'missing' as 'orch', runner)).toEqual({
    status: 'absent',
  })
  expect(calls.every((call) => call.timeoutMs === SETUP_COMMAND_TIMEOUT_MS)).toBe(true)
})

test.each([
  {
    harness: 'codex' as const,
    stdout: '',
    stderr: "Error: No MCP server named 'orch' found.",
  },
  {
    harness: 'claude' as const,
    stdout:
      'No MCP server named "orch". Configured servers: probe (.mcp.json servers are awaiting approval — run `claude` in this directory to review them.)',
    stderr: '',
  },
])('recognizes $harness exact missing-server diagnostic', ({ harness, stdout, stderr }) => {
  expect(
    readMcpRegistration(harness, `/bin/${harness}`, 'orch', () => result(stdout, 1, stderr)),
  ).toEqual({ status: 'absent' })
})

test('recognizes Claude missing-server diagnostics by their exact first-line prefix', () => {
  expect(
    readMcpRegistration('claude', '/bin/claude', 'orch', () =>
      result('No MCP server named "orch".', 1),
    ),
  ).toEqual({ status: 'absent' })
  expect(
    readMcpRegistration('claude', '/bin/claude', 'orch', () =>
      result('No MCP server named "other". Configured servers: probe', 1),
    ),
  ).toEqual({ status: 'unreadable', detail: 'exit code 1' })
  expect(
    readMcpRegistration('claude', '/bin/claude', 'orch', () =>
      result('configuration file not found', 1),
    ),
  ).toEqual({ status: 'unreadable', detail: 'exit code 1' })
})

test('recognizes Grok absence from its successful real empty-list output', () => {
  expect(readMcpRegistration('grok', '/bin/grok', 'orch', () => result('[]'))).toEqual({
    status: 'absent',
  })
})

test.each(['codex', 'claude', 'grok'] as const)(
  '%s does not classify unrelated not-found failures as absent',
  (harness) => {
    const readback = readMcpRegistration(harness, `/bin/${harness}`, 'orch', () =>
      result('', 1, 'configuration file not found'),
    )
    expect(readback).toEqual({ status: 'unreadable', detail: 'exit code 1' })
  },
)

test('rules out timeout and spawn errors before missing-server diagnostics', () => {
  const missing = "Error: No MCP server named 'orch' found."
  expect(
    readMcpRegistration('codex', '/bin/codex', 'orch', () => ({
      ...result('', 1, missing),
      timedOut: true,
    })),
  ).toEqual({ status: 'unreadable', detail: 'timed out' })
  expect(
    readMcpRegistration('codex', '/bin/codex', 'orch', () => ({
      ...result('', 1, missing),
      error: 'spawn failed',
    })),
  ).toEqual({ status: 'unreadable', detail: 'spawn error' })
})

test('captures Grok list rows and marks unsupported harnesses manual', () => {
  const runner = () =>
    result(JSON.stringify([{ name: 'orch', command: '/bin/orch', args: ['mcp'] }]))
  expect(captureHarnessMcpFacts('grok', '/bin/grok', ['orch'], runner)).toMatchObject({
    support: 'automatic',
    registrations: {
      orch: { status: 'registered', command: '/bin/orch', args: ['mcp'] },
    },
  })
  expect(captureHarnessMcpFacts('goose', '/bin/goose', ['orch'], runner)).toEqual({
    support: 'manual',
    registrations: {},
  })
})

test('uses each harness exact user-scope add form', () => {
  const server = { name: 'orch' as const, command: '/bin/orch', args: ['mcp'] }
  expect(mcpAddArgv('claude', '/bin/claude', server)).toEqual([
    '/bin/claude',
    'mcp',
    'add',
    '--scope',
    'user',
    'orch',
    '--',
    '/bin/orch',
    'mcp',
  ])
  expect(mcpAddArgv('codex', '/bin/codex', server)).toEqual([
    '/bin/codex',
    'mcp',
    'add',
    'orch',
    '--',
    '/bin/orch',
    'mcp',
  ])
  expect(mcpAddArgv('grok', '/bin/grok', server)).toContain('user')
  expect(mcpRemoveArgv('claude', '/bin/claude', 'orch')).toEqual([
    '/bin/claude',
    'mcp',
    'remove',
    '--scope',
    'user',
    'orch',
  ])
})
