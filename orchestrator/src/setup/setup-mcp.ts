// concern: setup-mcp
/** Knows harness MCP CLI grammar and bounded execution. Must not know setup questions or projects. */

import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { redactSecretShaped } from '../../../shared/secret-shaped.ts'
import { bottegaEntryArgv, bottegaMcpServeArgv } from '../../../shared/self-spawn.ts'
import { LEGACY_MCP_SERVER_NAMES, type LegacyMcpServerName } from './setup-mcp-config.ts'

export type { LegacyMcpServerName } from './setup-mcp-config.ts'
export const SETUP_COMMAND_TIMEOUT_MS = 5_000
const MCP_SERVER_NAMES = [MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME] as const
export function legacyMcpServerName(name: McpServerName): LegacyMcpServerName {
  return LEGACY_MCP_SERVER_NAMES[name]
}
export type McpServerName = (typeof MCP_SERVER_NAMES)[number]
type HarnessMcpDescriptor = {
  support: 'automatic' | 'manual'
  servers: readonly McpServerName[]
  manualDocumentation: string | null
}
export const HARNESS_MCP_CATALOGUE = {
  codex: {
    support: 'automatic',
    servers: MCP_SERVER_NAMES,
    manualDocumentation: null,
  },
  grok: {
    support: 'automatic',
    servers: MCP_SERVER_NAMES,
    manualDocumentation: null,
  },
  claude: {
    support: 'automatic',
    servers: [MCP_SERVER_NAME],
    manualDocumentation: null,
  },
  opencode: {
    support: 'manual',
    servers: [MCP_SERVER_NAME],
    manualDocumentation: 'https://opencode.ai/v2/docs/mcp-servers',
  },
  goose: {
    support: 'manual',
    servers: [MCP_SERVER_NAME],
    manualDocumentation: 'https://block.github.io/goose/',
  },
} as const satisfies Record<string, HarnessMcpDescriptor>
export type HarnessName = keyof typeof HARNESS_MCP_CATALOGUE
export function harnessMcpServers(harness: HarnessName): readonly McpServerName[] {
  return HARNESS_MCP_CATALOGUE[harness].servers
}
export type McpServer = {
  name: McpServerName
  command: string
  args: string[]
}
export type SetupCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error: string | null
}
export type SetupCommandRunner = (argv: string[], timeoutMs: number) => SetupCommandResult
export type McpReadback =
  | { status: 'absent' }
  | { status: 'registered'; command: string; args: string[] }
  | { status: 'stale'; command: string; args: string[]; detail: string }
  | { status: 'different'; command: string; args: string[]; detail: string }
  | { status: 'unreadable'; detail: string }

export type HarnessMcpFacts = {
  support: 'automatic' | 'manual'
  registrations: Partial<Record<McpServerName, McpReadback>>
  legacyRegistrations?: Partial<Record<LegacyMcpServerName, McpReadback>>
}

/** The stable entries persisted in harness configuration. */
export function stableMcpServers(): McpServer[] {
  const [command, ...prefix] = bottegaEntryArgv(PLATFORM_SLUG)
  const [serving, ...servingArgs] = bottegaMcpServeArgv()
  return [
    { name: MCP_SERVER_NAME, command: serving!, args: servingArgs },
    {
      name: WORKER_MCP_SERVER_NAME,
      command: command!,
      args: [...prefix, 'mcp', 'ask-server'],
    },
  ]
}

export function runSetupCommand(
  argv: string[],
  timeoutMs = SETUP_COMMAND_TIMEOUT_MS,
): SetupCommandResult {
  try {
    const env = { ...process.env }
    delete env.CLAUDE_CODE_SESSION_ID
    delete env.CLAUDE_CODE_BRIDGE_SESSION_ID
    env.BOTTEGA_ORCHESTRATOR_DB = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const child = Bun.spawnSync(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      env,
    })
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      timedOut: child.exitedDueToTimeout === true,
      error: null,
    }
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function manualMcpInstructions(harness: HarnessName): string {
  return `run ${PLATFORM_SLUG} mcp serve --config and follow ${HARNESS_MCP_CATALOGUE[harness].manualDocumentation ?? 'the harness MCP documentation'}`
}

function mcpReadArgv(
  harness: HarnessName,
  bin: string,
  name: McpServerName | LegacyMcpServerName,
): string[] {
  if (harness === 'claude') return [bin, 'mcp', 'get', name]
  if (harness === 'codex') return [bin, 'mcp', 'get', name, '--json']
  if (harness === 'grok') return [bin, 'mcp', 'list', '--json']
  throw new Error(`${harness} has no automatic MCP registration support`)
}

export function mcpAddArgv(harness: HarnessName, bin: string, server: McpServer): string[] {
  if (harness === 'claude')
    return [bin, 'mcp', 'add', '--scope', 'user', server.name, '--', server.command, ...server.args]
  if (harness === 'codex')
    return [bin, 'mcp', 'add', server.name, '--', server.command, ...server.args]
  if (harness === 'grok')
    return [bin, 'mcp', 'add', '--scope', 'user', server.name, '--', server.command, ...server.args]
  throw new Error(`${harness} has no automatic MCP registration support`)
}

export function mcpRemoveArgv(
  harness: HarnessName,
  bin: string,
  name: McpServerName | LegacyMcpServerName,
): string[] {
  if (harness === 'claude') return [bin, 'mcp', 'remove', '--scope', 'user', name]
  if (harness === 'codex') return [bin, 'mcp', 'remove', name]
  if (harness === 'grok') return [bin, 'mcp', 'remove', '--scope', 'user', name]
  throw new Error(`${harness} has no automatic MCP registration support`)
}

function parseJson(text: string): unknown {
  const start = Math.min(
    ...['{', '['].map((token) => {
      const index = text.indexOf(token)
      return index < 0 ? Number.POSITIVE_INFINITY : index
    }),
  )
  if (!Number.isFinite(start)) throw new Error('output contained no JSON')
  return JSON.parse(text.slice(start))
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function resultFailure(result: SetupCommandResult): string | null {
  if (result.timedOut) return 'timed out'
  if (result.error) return 'spawn error'
  if (result.exitCode !== 0) return `exit code ${String(result.exitCode)}`
  return null
}

function output(result: SetupCommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim()
}

function parseCodex(result: SetupCommandResult, name: string): McpReadback {
  if (result.timedOut || result.error) return unreadable(result)
  if (result.exitCode !== 0) {
    if (output(result) === `Error: No MCP server named '${name}' found.`)
      return { status: 'absent' }
    return unreadable(result)
  }
  try {
    const value = parseJson(result.stdout) as {
      transport?: { type?: string; command?: unknown; args?: unknown }
      type?: string
      command?: unknown
      args?: unknown
    }
    const transport = value.transport ?? value
    const args = stringArray(transport.args)
    if (transport.type && transport.type !== 'stdio') throw new Error('registration is not stdio')
    if (typeof transport.command !== 'string' || !args) throw new Error('missing command or args')
    return { status: 'registered', command: transport.command, args }
  } catch {
    return {
      status: 'unreadable',
      detail: 'parse failure: invalid Codex MCP JSON',
    }
  }
}

function parseGrok(result: SetupCommandResult, name: string): McpReadback {
  if (result.timedOut || result.error) return unreadable(result)
  if (result.exitCode !== 0) return unreadable(result)
  try {
    const value = parseJson(result.stdout)
    if (!Array.isArray(value)) throw new Error('expected a JSON array')
    const row = value.find(
      (candidate) => candidate && typeof candidate === 'object' && candidate.name === name,
    ) as { command?: unknown; args?: unknown } | undefined
    if (!row) return { status: 'absent' }
    const args = stringArray(row.args)
    if (typeof row.command !== 'string' || !args) throw new Error('missing command or args')
    return { status: 'registered', command: row.command, args }
  } catch {
    return {
      status: 'unreadable',
      detail: 'parse failure: invalid Grok MCP JSON',
    }
  }
}

function parseClaude(result: SetupCommandResult, name: string): McpReadback {
  if (result.timedOut || result.error) return unreadable(result)
  if (result.exitCode !== 0) {
    const firstLine = output(result).split(/\r?\n/, 1)[0]
    if (firstLine?.startsWith(`No MCP server named "${name}".`)) return { status: 'absent' }
    return unreadable(result)
  }
  const command = result.stdout.match(/^\s*Command:\s*(.+?)\s*$/im)?.[1]
  const rawArgs = result.stdout.match(/^\s*Args:\s*(.*?)\s*$/im)?.[1]
  if (!command || rawArgs === undefined)
    return {
      status: 'unreadable',
      detail: 'Claude MCP output did not include Command and Args',
    }
  try {
    const args = rawArgs.startsWith('[')
      ? stringArray(JSON.parse(rawArgs))
      : rawArgs.split(/\s+/).filter(Boolean)
    if (!args) throw new Error('Args was not a string array')
    return { status: 'registered', command, args }
  } catch {
    return {
      status: 'unreadable',
      detail: 'parse failure: invalid Claude MCP arguments',
    }
  }
}

function unreadable(result: SetupCommandResult): McpReadback {
  return {
    status: 'unreadable',
    detail: resultFailure(result) ?? 'parse failure',
  }
}

export function readMcpRegistration(
  harness: HarnessName,
  bin: string,
  name: McpServerName | LegacyMcpServerName,
  runner: SetupCommandRunner = runSetupCommand,
): McpReadback {
  const result = runner(mcpReadArgv(harness, bin, name), SETUP_COMMAND_TIMEOUT_MS)
  if (harness === 'codex') return parseCodex(result, name)
  if (harness === 'grok') return parseGrok(result, name)
  return parseClaude(result, name)
}

export function captureHarnessMcpFacts(
  harness: HarnessName,
  bin: string,
  servers: McpServer[],
  runner: SetupCommandRunner = runSetupCommand,
  commandExists: (path: string) => boolean,
  findCommand: (name: string) => string | null,
): HarnessMcpFacts {
  if (HARNESS_MCP_CATALOGUE[harness].support === 'manual')
    return { support: 'manual', registrations: {}, legacyRegistrations: {} }
  return {
    support: 'automatic',
    registrations: Object.fromEntries(
      servers.map((server) => {
        const readback = readMcpRegistration(harness, bin, server.name, runner)
        return [
          server.name,
          classifyMcpRegistration(
            readback,
            server,
            readback.status !== 'registered' ||
              registeredCommandResolves(readback.command, commandExists, findCommand),
          ),
        ]
      }),
    ),
    legacyRegistrations: Object.fromEntries(
      Object.values(LEGACY_MCP_SERVER_NAMES).map((name) => [
        name,
        readMcpRegistration(harness, bin, name, runner),
      ]),
    ),
  }
}

/** Resolve absolute/relative paths directly and bare commands through PATH. */
export function registeredCommandResolves(
  command: string,
  commandExists: (path: string) => boolean,
  findCommand: (name: string) => string | null,
): boolean {
  return /[\\/]/.test(command) ? commandExists(command) : findCommand(command) !== null
}

/** Classify a raw read-back against the stable entry using already-gathered filesystem facts. */
export function classifyMcpRegistration(
  readback: McpReadback,
  server: McpServer,
  commandExists: boolean,
): McpReadback {
  if (readback.status !== 'registered') return readback
  if (!commandExists)
    return {
      ...readback,
      status: 'stale',
      detail: 'registered command does not exist',
    }
  if (!sameMcpRegistration(readback, server))
    return {
      ...readback,
      status: 'different',
      detail: 'registered command or arguments differ',
    }
  return readback
}

export function sameMcpRegistration(readback: McpReadback, server: McpServer): boolean {
  return (
    readback.status === 'registered' &&
    readback.command === server.command &&
    JSON.stringify(readback.args) === JSON.stringify(server.args)
  )
}

export function commandFailureReason(result: SetupCommandResult): string {
  return resultFailure(result) ?? 'command failed without a structural reason'
}

export function screenedMcpField(value: unknown): string {
  const rendered = JSON.stringify(value)
  const redacted = redactSecretShaped(rendered).text
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted
}
