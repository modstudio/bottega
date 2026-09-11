// concern: mcp-preflight
/**
 * Knows MCP request/provenance vocabulary and Grok's connection diagnostic.
 * Must not know run state, transports, routing, or database mutation.
 */
import type { CanonSource } from './contract.ts'

export type McpConnection = {
  server: string
  connected: boolean | null
  error: string | null
  namesSeen?: string[]
}

export type McpMode = 'require' | 'prefer'
export type McpRequest = boolean | McpMode

export function requestedMcpMode(request: McpRequest | undefined): McpMode | null {
  if (request === 'prefer') return 'prefer'
  return request ? 'require' : null
}

/** Existing run.mcp stores none=0, require=1, and prefer=2. */
export function storedMcpRequest(request: McpRequest | undefined): number {
  const mode = requestedMcpMode(request)
  return mode === 'prefer' ? 2 : mode === 'require' ? 1 : 0
}

/** Read the tri-state request while preserving compatibility with older mirror rows. */
export function mcpRequestFromStored(
  stored: number | null, error: string | null = null,
): McpMode | undefined {
  if (stored === 2) return 'prefer'
  if (stored === 1) return error?.startsWith('mirror:') ? 'prefer' : 'require'
  return undefined
}

/** The provenance value orch can establish from this run's dispatch facts. */
export function canonSourceFor(
  mcpRequested: boolean,
  connection: McpConnection | null,
  mirrorAvailable: boolean,
): CanonSource {
  if (!mcpRequested) return mirrorAvailable ? 'mirror' : 'unknown'
  if (connection?.connected === true) return 'live database'
  if (connection?.connected === false) return 'mirror'
  return 'unknown'
}

export function canonSourceInstruction(source: CanonSource): string {
  return (
    `Canon source provenance: set provenance.canon_source to "${source}" in your reply. ` +
    'This reports the canon source available to this run, whether or not you consulted canon.'
  )
}

/**
 * Ask the same client that will run the lens whether its project MCP can start.
 * Grok gates repo-local MCP behind folder trust separately from permission
 * mode. The deferred orch-worktree path passes trust; caller-checkout probes do not.
 */
export function grokMcpConnection(
  bin: string, cwd: string, server: string, env: Record<string, string>, trust = false,
): McpConnection {
  const p = Bun.spawnSync([
    bin, ...(trust ? ['--cwd', cwd, '--trust'] : []), 'mcp', 'doctor', server, '--json',
  ], {
    cwd, env, stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = p.stdout.toString().trim()
  const stderr = p.stderr.toString().trim()
  try {
    const report = JSON.parse(stdout) as {
      servers?: { name?: string; healthy?: boolean; checks?: {
        passed?: boolean; label?: string; detail?: string; hint?: string
      }[] }[]
    }
    const found = report.servers?.find((candidate) => candidate.name === server)
    const available = (report.servers ?? [])
      .map((candidate) => candidate.name)
      .filter((name): name is string => Boolean(name))
    if (found) {
      const error = (found.checks ?? [])
        .filter((check) => check.passed === false)
        .map((check) => [check.label, check.detail, check.hint].filter(Boolean).join(': '))
        .join('; ')
      return { server, connected: found.healthy === true, error: error || null, namesSeen: available }
    }
    const listed = available.length ? available.join(', ') : '(none)'
    return {
      server,
      connected: false,
      namesSeen: available,
      error: [
        stderr, stdout,
        `MCP server '${server}' was not reported. Available: ${listed}`,
      ].filter(Boolean).join('\n'),
    }
  } catch { /* preserve the client's actual diagnostic below */ }
  return {
    server,
    connected: false,
    error: [stderr, stdout].filter(Boolean).join('\n') || `MCP server '${server}' was not reported`,
  }
}
