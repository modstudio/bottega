// concern: mcp-preflight
/**
 * Knows MCP request/provenance vocabulary and Grok's connection diagnostic.
 * Must not know run state, transports, routing, or database mutation.
 */

import { AGENTS } from '../agent/agent-registry.ts'
import type { CanonSource } from '../contract/contract.ts'
import { job } from '../jobs.ts'
import { projectAt, validateStoredProjectSettings } from '../projects.ts'
import { childEnv } from '../run-process.ts'

export type McpConnection = {
  server: string
  connected: boolean | null
  error: string | null
  namesSeen?: string[]
}

export type McpMode = 'require' | 'prefer'
export type McpRequest = boolean | McpMode

export function effectiveMcpRequest(
  request: McpRequest | undefined,
  declaredJob: { needs: { mcp?: boolean } },
): McpRequest | undefined {
  return request ?? (declaredJob.needs.mcp ? true : undefined)
}

export function provenanceServer(entry: string, knownServers: ReadonlySet<string>): string | null {
  const claude = entry.match(/^mcp__(.+?)__/)
  if (claude) return claude[1] ?? null

  const codexApps = entry.match(/^codex_apps\.(.+)$/)
  if (codexApps) {
    const rest = codexApps[1]!
    let match: string | null = null
    for (const server of knownServers) {
      if (rest.startsWith(`${server}_mcp_`) && (match === null || server.length > match.length)) {
        match = server
      }
    }
    return match ?? 'codex_apps'
  }

  return entry.match(/^([^.:/]+)[.:/]/)?.[1] ?? null
}

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
  stored: number | null,
  error: string | null = null,
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
 * Grok gates repo-local MCP behind folder trust and reads its scoped server
 * clamp from the run's GROK_HOME. Caller-checkout probes do not pass trust.
 */
function grokMcpConnection(
  bin: string,
  cwd: string,
  server: string,
  env: Record<string, string>,
  trust = false,
): McpConnection {
  const p = Bun.spawnSync(
    [bin, ...(trust ? ['--cwd', cwd, '--trust'] : []), 'mcp', 'doctor', server, '--json'],
    {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdout = p.stdout.toString().trim()
  const stderr = p.stderr.toString().trim()
  try {
    const report = JSON.parse(stdout) as {
      servers?: {
        name?: string
        healthy?: boolean
        checks?: {
          passed?: boolean
          label?: string
          detail?: string
          hint?: string
        }[]
      }[]
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
      return {
        server,
        connected: found.healthy === true,
        error: error || null,
        namesSeen: available,
      }
    }
    const listed = available.length ? available.join(', ') : '(none)'
    return {
      server,
      connected: false,
      namesSeen: available,
      error: [stderr, stdout, `MCP server '${server}' was not reported. Available: ${listed}`]
        .filter(Boolean)
        .join('\n'),
    }
  } catch {
    /* preserve the client's actual diagnostic below */
  }
  return {
    server,
    connected: false,
    error: [stderr, stdout].filter(Boolean).join('\n') || `MCP server '${server}' was not reported`,
  }
}

export function mcpConnectionFor(
  name: string,
  cwd: string,
  server: string,
  trust = false,
  includeStore = true,
  env: Record<string, string> = {},
): McpConnection {
  if (name === 'grok') {
    const grok = AGENTS.grok!
    return grokMcpConnection(
      grok.bin,
      cwd,
      server,
      childEnv(grok, undefined, undefined, env, includeStore),
      trust,
    )
  }
  return {
    server,
    connected: null,
    error: `${name} does not expose an MCP connection diagnostic`,
  }
}

export function mcpAttachRefusal(connection: McpConnection): string | null {
  if (connection.connected !== false) return null
  return (
    `MCP was requested, but server '${connection.server}' could not be attached` +
    `${connection.error ? `: ${connection.error}` : '.'} The agent was not started.`
  )
}

export function assertGrokTrustEligible(
  cwd: string,
  recorded: {
    id?: number
    cwd?: string | null
    worktree: string | null
    worktree_source: string | null
  } | null,
  isolatePath: string,
): void {
  const orchCut =
    recorded?.worktree === cwd &&
    ['recipe', 'git', 'readonly_recipe'].includes(recorded.worktree_source ?? '')
  const orchIsolate =
    recorded?.worktree === null &&
    recorded.id !== undefined &&
    recorded.cwd === cwd &&
    isolatePath === cwd
  if (orchCut || orchIsolate) return
  throw new Error(
    `refusing Grok trust for ${cwd}: trust is granted only to trees orch cut; ` +
      'removed tree paths never recur',
  )
}

export function probeRequestedMcp(
  mcp: McpRequest | undefined,
  agent: string,
  cwd: string,
): McpConnection | null {
  if (!requestedMcpMode(mcp)) return null
  const project = projectAt(cwd)
  if (!project) return null
  return mcpConnectionFor(agent, cwd, project.settings.mcpServer ?? project.name)
}

export function preflightMcp(opts: {
  mcp?: McpRequest
  cwd: string
  job: string
  selectedAgent: string
}): void {
  const mode = requestedMcpMode(opts.mcp)
  if (!mode) return
  const project = projectAt(opts.cwd)
  if (!project) return
  const malformed = validateStoredProjectSettings(project.settings, project.path)
  if (malformed.length) throw new Error(malformed.join('\n'))
  const selected = AGENTS[opts.selectedAgent]!
  if (!job(opts.job).needs.readsRepo || selected.caps.discoversMcpFromCwd) return
  const connection = probeRequestedMcp(mode, opts.selectedAgent, opts.cwd)
  if (!connection) return
  const why = mcpAttachRefusal(connection)
  if (why && mode === 'require') throw new Error(why)
}
