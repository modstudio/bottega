// concern: project-mcp-preflight
/**
 * Probes the launch each selected project MCP server will actually get, so a
 * server a strict run requires is refused before launch instead of failing
 * silently. Must not know run state, argv, routes, or credentials.
 */
import { join } from 'node:path'
import {
  MCP_SERVER_NAME,
  PLATFORM_SLUG,
  WORKER_MCP_SERVER_NAME,
} from '../../../shared/brand.ts'
import type { McpMode } from '../mcp/mcp-preflight.ts'
import { listMcpToolPages, type McpToolListLaunch } from '../mcp/mcp-tool-list.ts'
import type { ProjectMcpSelection } from './project-mcp-scope.ts'

/** One project server the run gets, with the launch it actually gets it through. */
export type ProjectMcpProbe = { server: string; launch: McpToolListLaunch }

/** A selected server whose launch affirmed it could not start, and what it said. */
export type ProjectMcpProbeFailure = { server: string; error: string }

/** The launches a selection hands the run: a reader proxy, or the direct definition. */
export function projectMcpProbeLaunches(selection: ProjectMcpSelection | null): ProjectMcpProbe[] {
  if (!selection) return []
  return Object.entries(selection.servers).map(([server, launch]) => ({ server, launch }))
}

/** Probe every launch at once; each launch that fails becomes one failure. */
export async function probeProjectMcpLaunches(
  probes: readonly ProjectMcpProbe[],
  env: Record<string, string>,
): Promise<ProjectMcpProbeFailure[]> {
  const probed = await Promise.all(
    probes.map(async (probe) => {
      try {
        await listMcpToolPages(probe.launch, env)
        return null
      } catch (error) {
        // The launch-failure shaping in mcp-tool-list.ts already flattens and
        // withholds; this catch reports the shaped message unchanged.
        return { server: probe.server, error: String((error as Error)?.message ?? error) }
      }
    }),
  )
  return probed.filter((failure): failure is ProjectMcpProbeFailure => failure !== null)
}

export type RequiredMcpProbeFacts = {
  mode: McpMode | null
  project: { name: string; path: string } | null
  failures: readonly ProjectMcpProbeFailure[]
  /** The server this run's project requires, resolved the way the run resolves it. */
  requiredServer?: string | null
  /** The server names the run's selection actually hands it. */
  selectedServers?: readonly string[]
  /** The server names the selection withheld, and why. */
  withheld?: readonly string[]
}

/** True when the name belongs to a server the platform installs, not the tree. */
function isPlatformServer(name: string): boolean {
  return name === MCP_SERVER_NAME || name === WORKER_MCP_SERVER_NAME
}

/** A required server the selection did not hand over, and why. */
function missingRequiredServerFailure(facts: RequiredMcpProbeFacts): ProjectMcpProbeFailure | null {
  const required = facts.requiredServer
  if (!required || isPlatformServer(required)) return null
  if ((facts.selectedServers ?? []).includes(required)) return null
  const reason = (facts.withheld ?? []).includes(required)
    ? "withheld from this run's MCP scope (inline env/headers or no launch definition)"
    : "not configured in the tree's .mcp.json"
  return { server: required, error: reason }
}

/**
 * Decide whether a probe outcome refuses the run.
 *
 * Only `--mcp require` refuses, and only an affirmatively failed launch or a
 * required server the selection did not hand over does: a server whose
 * connection is merely unverifiable, which is what an agent with no connection
 * diagnostic gives the run, is not evidence of failure.
 */
export function requiredMcpProbeRefusal(facts: RequiredMcpProbeFacts): string | null {
  if (facts.mode !== 'require') return null
  const missing = missingRequiredServerFailure(facts)
  const failures = missing ? [missing, ...facts.failures] : facts.failures
  if (!failures.length) return null
  const configPath = facts.project ? join(facts.project.path, '.mcp.json') : '.mcp.json'
  const projectName = facts.project?.name ?? '<project>'
  const failureLines = failures.map((failure) => `${failure.server}: ${failure.error}`).join('\n')
  return (
    `--mcp require was asked for, but the project MCP launch did not start:\n${failureLines}` +
    `\ninvariant: --mcp require refuses a launch that affirmatively failed or a required server` +
    ` the run did not get, never a merely unverified connection` +
    `\ncleared by: the server's entry in ${configPath}, or by naming the server this project` +
    ` provides with ${PLATFORM_SLUG} project set ${projectName} --settings '{"mcpServer":"<server>"}'`
  )
}

/**
 * A required project launch that affirmatively failed before the run started.
 *
 * The run concern decides which failure kind records a refusal; this error
 * carries only the reason so the sandbox probe stays free of run-state
 * vocabulary.
 */
export class RequiredMcpProbeRefusalError extends Error {
  constructor(refusal: string) {
    super(refusal)
    this.name = 'RequiredMcpProbeRefusalError'
  }
}

/** The refusal a strict run raises, or null when the outcome does not refuse one. */
export function requiredMcpProbeRefusalError(
  facts: RequiredMcpProbeFacts,
): RequiredMcpProbeRefusalError | null {
  const refusal = requiredMcpProbeRefusal(facts)
  return refusal === null ? null : new RequiredMcpProbeRefusalError(refusal)
}
