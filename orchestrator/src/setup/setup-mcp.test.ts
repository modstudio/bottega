import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import {
  captureHarnessMcpFacts,
  classifyMcpRegistration,
  type McpServer,
  mcpAddArgv,
  mcpRemoveArgv,
  readMcpRegistration,
  registeredCommandResolves,
  SETUP_COMMAND_TIMEOUT_MS,
  type SetupCommandResult,
  stableMcpServers,
} from './setup-mcp.ts'
import { mcpRegistrationWriteRefusal } from './setup-registration-write.ts'

const FRONT_DOOR = join('/', 'bin', PLATFORM_SLUG)

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
      JSON.stringify({
        transport: { type: 'stdio', command: FRONT_DOOR, args: ['mcp'] },
      }),
    )
  }
  expect(readMcpRegistration('codex', '/bin/codex', 'orch', runner)).toEqual({
    status: 'registered',
    command: FRONT_DOOR,
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
    result(JSON.stringify([{ name: MCP_SERVER_NAME, command: FRONT_DOOR, args: ['mcp'] }]))
  const server: McpServer = { name: MCP_SERVER_NAME, command: FRONT_DOOR, args: ['mcp'] }
  expect(
    captureHarnessMcpFacts(
      'grok',
      '/bin/grok',
      [server],
      runner,
      () => true,
      () => null,
    ),
  ).toMatchObject({
    support: 'automatic',
    registrations: {
      [MCP_SERVER_NAME]: { status: 'registered', command: FRONT_DOOR, args: ['mcp'] },
    },
  })
  expect(
    captureHarnessMcpFacts(
      'goose',
      '/bin/goose',
      [server],
      runner,
      () => true,
      () => null,
    ),
  ).toEqual({ support: 'manual', registrations: {}, legacyRegistrations: {} })
})

test('classifies missing, different, and matching registrations', () => {
  const server: McpServer = {
    name: MCP_SERVER_NAME,
    command: `/bin/${PLATFORM_SLUG}`,
    args: ['mcp', 'serve'],
  }
  const matching = {
    status: 'registered' as const,
    command: server.command,
    args: server.args,
  }
  expect(classifyMcpRegistration(matching, server, false)).toEqual({
    ...matching,
    status: 'stale',
    detail: 'registered command does not exist',
  })
  expect(
    classifyMcpRegistration(
      {
        status: 'registered',
        command: `/other/${PLATFORM_SLUG}`,
        args: ['mcp', 'serve'],
      },
      server,
      true,
    ),
  ).toEqual({
    status: 'different',
    command: `/other/${PLATFORM_SLUG}`,
    args: ['mcp', 'serve'],
    detail: 'registered command or arguments differ',
  })
  expect(classifyMcpRegistration(matching, server, true)).toEqual(matching)
})

test('resolves registered path commands directly and bare commands through PATH', () => {
  expect(
    registeredCommandResolves(
      `/missing/${PLATFORM_SLUG}`,
      () => false,
      () => '/bin/ignored',
    ),
  ).toBe(false)
  expect(
    registeredCommandResolves(
      PLATFORM_SLUG,
      () => false,
      () => `/usr/local/bin/${PLATFORM_SLUG}`,
    ),
  ).toBe(true)
  expect(
    registeredCommandResolves(
      'missing-command',
      () => true,
      () => null,
    ),
  ).toBe(false)
})

test('linked-worktree registration refusal names the main checkout', () => {
  expect(mcpRegistrationWriteRefusal('/repo/worktree', false, '/repo')).toBeNull()
  expect(mcpRegistrationWriteRefusal('/repo/worktree', true, '/repo')).toContain(
    'run this command from the main checkout /repo',
  )
})

test('stable persisted registrations share the platform entry', () => {
  const [orch, ask] = stableMcpServers()
  expect(orch).toMatchObject({ name: MCP_SERVER_NAME, args: ['mcp', 'serve'] })
  expect(ask).toMatchObject({
    name: WORKER_MCP_SERVER_NAME,
    command: orch?.command,
    args: ['mcp', 'ask-server'],
  })
})

test('uses each harness exact user-scope add form', () => {
  const server: McpServer = { name: MCP_SERVER_NAME, command: FRONT_DOOR, args: ['mcp'] }
  expect(mcpAddArgv('claude', '/bin/claude', server)).toEqual([
    '/bin/claude',
    'mcp',
    'add',
    '--scope',
    'user',
    MCP_SERVER_NAME,
    '--',
    FRONT_DOOR,
    'mcp',
  ])
  expect(mcpAddArgv('codex', '/bin/codex', server)).toEqual([
    '/bin/codex',
    'mcp',
    'add',
    MCP_SERVER_NAME,
    '--',
    FRONT_DOOR,
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
