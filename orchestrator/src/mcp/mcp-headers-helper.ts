// concern: mcp-headers-helper
/** Resolves dynamic HTTP headers declared by a project MCP server. */

export type McpHeadersConfig = {
  name: string
  url?: string
  headers?: Record<string, string>
  headersHelper?: string
}

const MCP_HEADERS_HELPER_TIMEOUT_MS = 10_000

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

/** Run a configured helper at call time and return the effective HTTP headers. */
export async function resolveMcpHeaders(
  config: McpHeadersConfig,
  projectPath: string,
  baseEnvironment: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (!config.headersHelper) return config.headers
  const child = Bun.spawn(['/bin/sh', '-c', config.headersHelper], {
    cwd: projectPath,
    env: {
      ...baseEnvironment,
      CLAUDE_CODE_MCP_SERVER_NAME: config.name,
      CLAUDE_CODE_MCP_SERVER_URL: config.url ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, MCP_HEADERS_HELPER_TIMEOUT_MS)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer))
  const diagnostic = oneLineStderr(stderr)
  const suffix = diagnostic ? `; stderr: ${diagnostic}` : ''
  if (timedOut) {
    throw helperRefusal(config, `timed out after ${MCP_HEADERS_HELPER_TIMEOUT_MS}ms${suffix}`)
  }
  if (exitCode !== 0) throw helperRefusal(config, `exited with code ${exitCode}${suffix}`)
  return effectiveMcpHeaders(config, stdout)
}
