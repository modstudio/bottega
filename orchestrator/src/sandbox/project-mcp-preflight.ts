// concern: project-mcp-preflight
/**
 * Probes the launch each selected project MCP server will actually get, so a
 * server a strict run requires is refused before launch instead of failing
 * silently. Must not know run state, argv, routes, or credentials.
 */
import { MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import type { McpMode } from '../mcp/mcp-preflight.ts'
import { listMcpToolPages, type McpToolListLaunch } from '../mcp/mcp-tool-list.ts'
import {
  type ProjectMcpSelection,
  type ProjectMcpWithheld,
  projectMcpWriterRemedy,
} from './project-mcp-scope.ts'

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
  withheld?: readonly ProjectMcpWithheld[]
}

export type RequiredMcpProbeDecision = {
  refusal: string | null
  unrelatedFailures: readonly ProjectMcpProbeFailure[]
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
  const withheld = (facts.withheld ?? []).find((entry) => entry.name === required)
  let reason = "not configured in the tree's .mcp.json"
  if (withheld) {
    reason = `withheld from this run's MCP scope (${withheld.reason})`
    if (withheld.advice) reason += `; ${withheld.advice}`
  }
  return { server: required, error: reason }
}

/**
 * Decide whether a probe outcome refuses the run and which failures may warn.
 *
 * A scoped `--mcp require` refusal includes only its required server: either its
 * affirmatively failed launch or the selection's failure to hand it over. Other
 * failed launches are returned for non-refusing warnings. Without a scoped
 * project server, any affirmative failure refuses as before. A server whose
 * connection is merely unverifiable is not evidence of failure.
 */
export function requiredMcpProbeDecision(facts: RequiredMcpProbeFacts): RequiredMcpProbeDecision {
  if (facts.mode !== 'require') return { refusal: null, unrelatedFailures: [] }
  const missing = missingRequiredServerFailure(facts)
  const required = facts.requiredServer
  const scoped = Boolean(required && !isPlatformServer(required))
  const failures = missing
    ? [missing]
    : scoped
      ? facts.failures.filter((failure) => failure.server === required)
      : facts.failures
  const unrelatedFailures = scoped
    ? facts.failures.filter((failure) => failure.server !== required)
    : []
  if (!failures.length) return { refusal: null, unrelatedFailures }
  const withheld = required
    ? (facts.withheld ?? []).find((entry) => entry.name === required)
    : undefined
  const remedy = withheld?.remedy ?? projectMcpWriterRemedy(facts.project)
  const failureLines = failures.map((failure) => `${failure.server}: ${failure.error}`).join('\n')
  return {
    refusal:
      `--mcp require was asked for, but the project MCP launch did not start:\n${failureLines}` +
      `\ninvariant: --mcp require refuses a launch that affirmatively failed or a required server` +
      ` the run did not get, never a merely unverified connection` +
      `\ncleared by: ${remedy}`,
    unrelatedFailures,
  }
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
