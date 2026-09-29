// concern: setup-mcp
/** Knows harness MCP CLI grammar and bounded execution. Must not know setup questions or projects. */
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'

export const SETUP_COMMAND_TIMEOUT_MS = 5_000
const MCP_SERVER_NAMES = ['orch', 'orch-ask'] as const
export type McpServerName = (typeof MCP_SERVER_NAMES)[number]
type HarnessMcpDescriptor = {
  support: 'automatic' | 'manual'
  servers: readonly McpServerName[]
  manualDocumentation: string | null
}
export const HARNESS_MCP_CATALOGUE = {
  codex: { support: 'automatic', servers: ['orch', 'orch-ask'], manualDocumentation: null },
  grok: { support: 'automatic', servers: ['orch', 'orch-ask'], manualDocumentation: null },
  claude: { support: 'automatic', servers: ['orch'], manualDocumentation: null },
  opencode: {
    support: 'manual',
    servers: ['orch'],
    manualDocumentation: 'https://opencode.ai/v2/docs/mcp-servers',
  },
  goose: {
    support: 'manual',
    servers: ['orch'],
    manualDocumentation: 'https://block.github.io/goose/',
  },
} as const satisfies Record<string, HarnessMcpDescriptor>
export type HarnessName = keyof typeof HARNESS_MCP_CATALOGUE
export function harnessMcpServers(harness: HarnessName): readonly McpServerName[] {
  return HARNESS_MCP_CATALOGUE[harness].servers
}
export type McpServer = { name: McpServerName; command: string; args: string[] }
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
  | { status: 'unreadable'; detail: string }

export type HarnessMcpFacts = {
  support: 'automatic' | 'manual'
  registrations: Partial<Record<McpServerName, McpReadback>>
}

export function runSetupCommand(
  argv: string[],
  timeoutMs = SETUP_COMMAND_TIMEOUT_MS,
): SetupCommandResult {
  try {
    const env = { ...process.env }
    delete env.CLAUDE_CODE_SESSION_ID
    delete env.CLAUDE_CODE_BRIDGE_SESSION_ID
    env.ORCH_DB = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const child = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, env })
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
  return `run orch mcp --config and follow ${HARNESS_MCP_CATALOGUE[harness].manualDocumentation ?? 'the harness MCP documentation'}`
}

function mcpReadArgv(harness: HarnessName, bin: string, name: McpServerName): string[] {
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

export function mcpRemoveArgv(harness: HarnessName, bin: string, name: McpServerName): string[] {
  if (harness === 'claude') return [bin, 'mcp', 'remove', '--scope', 'user', name]
  throw new Error(`${harness} does not require removing an MCP registration before replacement`)
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

function parseCodex(result: SetupCommandResult, name: McpServerName): McpReadback {
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
    return { status: 'unreadable', detail: 'parse failure: invalid Codex MCP JSON' }
  }
}

function parseGrok(result: SetupCommandResult, name: McpServerName): McpReadback {
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
    return { status: 'unreadable', detail: 'parse failure: invalid Grok MCP JSON' }
  }
}

function parseClaude(result: SetupCommandResult, name: McpServerName): McpReadback {
  if (result.timedOut || result.error) return unreadable(result)
  if (result.exitCode !== 0) {
    const firstLine = output(result).split(/\r?\n/, 1)[0]
    if (firstLine?.startsWith(`No MCP server named "${name}".`)) return { status: 'absent' }
    return unreadable(result)
  }
  const command = result.stdout.match(/^\s*Command:\s*(.+?)\s*$/im)?.[1]
  const rawArgs = result.stdout.match(/^\s*Args:\s*(.*?)\s*$/im)?.[1]
  if (!command || rawArgs === undefined)
    return { status: 'unreadable', detail: 'Claude MCP output did not include Command and Args' }
  try {
    const args = rawArgs.startsWith('[')
      ? stringArray(JSON.parse(rawArgs))
      : rawArgs.split(/\s+/).filter(Boolean)
    if (!args) throw new Error('Args was not a string array')
    return { status: 'registered', command, args }
  } catch {
    return { status: 'unreadable', detail: 'parse failure: invalid Claude MCP arguments' }
  }
}

function unreadable(result: SetupCommandResult): McpReadback {
  return { status: 'unreadable', detail: resultFailure(result) ?? 'parse failure' }
}

export function readMcpRegistration(
  harness: HarnessName,
  bin: string,
  name: McpServerName,
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
  names: McpServerName[],
  runner: SetupCommandRunner = runSetupCommand,
): HarnessMcpFacts {
  if (HARNESS_MCP_CATALOGUE[harness].support === 'manual')
    return { support: 'manual', registrations: {} }
  return {
    support: 'automatic',
    registrations: Object.fromEntries(
      names.map((name) => [name, readMcpRegistration(harness, bin, name, runner)]),
    ),
  }
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
  if (containsSecretShaped(rendered)) return '[withheld: secret-shaped]'
  return rendered.length > 500 ? `${rendered.slice(0, 500)}…` : rendered
}
