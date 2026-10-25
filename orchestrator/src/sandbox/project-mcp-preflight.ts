// concern: project-mcp-preflight
/**
 * Probes the launch each selected project MCP server will actually get, so a
 * server a strict run requires is refused before launch instead of failing
 * silently. Must not know run state, argv, routes, or credentials.
 */
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
        return {
          server: probe.server,
          error: String((error as Error)?.message ?? error)
            .replaceAll(/\s+/g, ' ')
            .trim(),
        }
      }
    }),
  )
  return probed.filter((failure): failure is ProjectMcpProbeFailure => failure !== null)
}

export type RequiredMcpProbeFacts = {
  mode: McpMode | null
  project: { name: string; path: string } | null
  failures: readonly ProjectMcpProbeFailure[]
}

/**
 * Decide whether a probe outcome refuses the run.
 *
 * Only `--mcp require` refuses, and only an affirmatively failed launch does: a
 * server whose connection is merely unverifiable, which is what an agent with no
 * connection diagnostic gives the run, is not evidence of failure.
 */
export function requiredMcpProbeRefusal(facts: RequiredMcpProbeFacts): string | null {
  if (facts.mode !== 'require' || !facts.failures.length) return null
  const configPath = facts.project ? join(facts.project.path, '.mcp.json') : '.mcp.json'
  const projectName = facts.project?.name ?? '<project>'
  const failures = facts.failures.map((failure) => `${failure.server}: ${failure.error}`).join('\n')
  return (
    `--mcp require was asked for, but the project MCP launch did not start:\n${failures}` +
    `\ninvariant: --mcp require refuses a launch that affirmatively failed, never one that is merely unverified` +
    `\ncleared by: the failed server's entry in ${configPath}, or by naming the server this project` +
    ` provides with ${PLATFORM_SLUG} project set ${projectName} --settings '{"mcpServer":"<server>"}'`
  )
}
