// concern: mcp-headers-helper
/** Resolves dynamic HTTP headers declared by a project MCP server. */

import { withholdSecretShapedLines } from '../secret-shaped-output.ts'

export type McpHeadersConfig = {
  name: string
  url?: string
  headers?: Record<string, string>
  headersHelper?: string
}

const MCP_HEADERS_HELPER_TIMEOUT_MS = 10_000
const MCP_HEADERS_HELPER_KILL_GRACE_MS = 250

type CommandWrapper = (command: string, args: string[]) => string[] | Promise<string[]>

const helperRefusal = (config: McpHeadersConfig, condition: string): Error =>
  new McpHeadersHelperError(
    `MCP server ${JSON.stringify(config.name)} headersHelper ${JSON.stringify(config.headersHelper)} ${condition}`,
  )

export class McpHeadersHelperError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpHeadersHelperError'
  }
}

/** Parse helper output and merge it over static headers without case-sensitive duplicates. */
export function effectiveMcpHeaders(
  config: McpHeadersConfig,
  stdout: string,
): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw helperRefusal(config, 'did not print JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw helperRefusal(config, 'did not print a JSON object')
  }
  const dynamic = parsed as Record<string, unknown>
  const nonString = Object.entries(dynamic).find(([, value]) => typeof value !== 'string')
  if (nonString) {
    throw helperRefusal(
      config,
      `printed a non-string value for header ${JSON.stringify(nonString[0])}`,
    )
  }
  const dynamicNames = new Set(Object.keys(dynamic).map((name) => name.toLowerCase()))
  return {
    ...Object.fromEntries(
      Object.entries(config.headers ?? {}).filter(
        ([name]) => !dynamicNames.has(name.toLowerCase()),
      ),
    ),
    ...(dynamic as Record<string, string>),
  }
}

const oneLineStderr = (stderr: string): string => stderr.split(/\r?\n/, 1)[0]!.trim().slice(0, 400)

/**
 * Run a configured helper at call time and return the effective HTTP headers.
 * A caller resolves only for a URL launch, using that launch's environment and
 * sandbox wrapper when it has one.
 */
export async function resolveMcpHeaders(
  config: McpHeadersConfig,
  projectPath: string,
  baseEnvironment: Record<string, string>,
  wrap?: CommandWrapper,
): Promise<Record<string, string> | undefined> {
  if (!config.headersHelper) return config.headers
  const raw = ['/bin/sh', '-c', config.headersHelper]
  const argv = wrap ? await wrap(raw[0]!, raw.slice(1)) : raw
  const child = Bun.spawn(argv, {
    cwd: projectPath,
    env: {
      ...baseEnvironment,
      CLAUDE_CODE_MCP_SERVER_NAME: config.name,
      CLAUDE_CODE_MCP_SERVER_URL: config.url ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  const completed = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  let timeoutHandle: ReturnType<typeof setTimeout>
  const timeout = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), MCP_HEADERS_HELPER_TIMEOUT_MS)
  })
  const result = await Promise.race([completed, timeout])
  clearTimeout(timeoutHandle!)
  if (result === null) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, MCP_HEADERS_HELPER_KILL_GRACE_MS).unref()
    void completed.catch(() => undefined)
    throw helperRefusal(config, `timed out after ${MCP_HEADERS_HELPER_TIMEOUT_MS}ms`)
  }
  const [stdout, stderr, exitCode] = result
  const diagnostic = withholdSecretShapedLines(oneLineStderr(stderr))
  const suffix = diagnostic ? `; stderr: ${diagnostic}` : ''
  if (exitCode !== 0) throw helperRefusal(config, `exited with code ${exitCode}${suffix}`)
  return effectiveMcpHeaders(config, stdout)
}
