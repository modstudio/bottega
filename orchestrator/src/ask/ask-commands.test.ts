import { expect, test } from 'bun:test'
import { PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { stableMcpServers } from '../setup/setup-mcp.ts'
import { setupAskCommand } from './ask-commands.ts'

test('setup-ask exits non-zero when any registration fails', async () => {
  const output: string[] = []
  const code = await setupAskCommand(
    { log: (line) => output.push(line) },
    {
      assertWriteAllowed: () => {},
      find: (name) => `/bin/${name}`,
      commandExists: () => true,
      runner: (argv) => ({
        exitCode: argv[0] === '/bin/grok' ? 1 : 0,
        stdout: argv.includes('get')
          ? `Command: /bin/${PLATFORM_SLUG}\nArgs: ["mcp","ask-server"]`
          : argv.includes('list')
            ? '[]'
            : '',
        stderr: argv[0] === '/bin/grok' ? 'registration failed' : '',
        timedOut: false,
        error: null,
      }),
    },
  )
  expect(code).toBe(1)
  expect(output.join('\n')).toContain('FAIL grok')
})

test('setup-ask refuses a present differing registration without adding it', async () => {
  const output: string[] = []
  const calls: string[][] = []
  const replaced = new Set<string>()
  const desired = stableMcpServers().find((server) => server.name === WORKER_MCP_SERVER_NAME)!
  const code = await setupAskCommand(
    { log: (line) => output.push(line) },
    {
      assertWriteAllowed: () => {},
      find: (name) => `/bin/${name}`,
      commandExists: () => true,
      runner: (argv) => {
        calls.push(argv)
        if (argv.includes('add')) replaced.add(argv[0]!)
        const entry = replaced.has(argv[0]!)
          ? { command: desired.command, args: desired.args }
          : { command: '/somewhere/else', args: [] }
        const stdout = argv.includes('get')
          ? JSON.stringify({ transport: { type: 'stdio', ...entry } })
          : JSON.stringify([{ name: WORKER_MCP_SERVER_NAME, ...entry }])
        return {
          exitCode: 0,
          stdout,
          stderr: '',
          timedOut: false,
          error: null,
        }
      },
    },
  )
  expect(code).toBe(1)
  expect(calls.filter((argv) => argv.includes('add'))).toHaveLength(0)
  expect(output.join('\n')).toContain('machine setup apply to review and replace it')
})

test('setup-ask replaces a registration whose command is missing', async () => {
  const output: string[] = []
  const calls: string[][] = []
  const replaced = new Set<string>()
  const desired = stableMcpServers().find((server) => server.name === WORKER_MCP_SERVER_NAME)!
  const code = await setupAskCommand(
    { log: (line) => output.push(line) },
    {
      assertWriteAllowed: () => {},
      find: (name) => `/bin/${name}`,
      commandExists: (path) => path === desired.command,
      runner: (argv) => {
        calls.push(argv)
        if (argv.includes('add')) replaced.add(argv[0]!)
        const entry = replaced.has(argv[0]!)
          ? { command: desired.command, args: desired.args }
          : { command: `/missing/${PLATFORM_SLUG}`, args: ['mcp', 'ask-server'] }
        const stdout = argv.includes('get')
          ? JSON.stringify({ transport: { type: 'stdio', ...entry } })
          : JSON.stringify([{ name: WORKER_MCP_SERVER_NAME, ...entry }])
        return {
          exitCode: 0,
          stdout,
          stderr: '',
          timedOut: false,
          error: null,
        }
      },
    },
  )
  expect(code).toBe(0)
  expect(calls.filter((argv) => argv.includes('add'))).toHaveLength(2)
  expect(output.join('\n')).toContain('bottega-ask registered and verified')
})
