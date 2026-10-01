// concern: task-key-lookup
/** Reads a task through the tracker protocol declared by its registered project. */
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { trackerSourceFor } from '../../../shared/trackers.ts'
import {
  type McpServerConfig,
  probeSecrets,
  readMcpConfig,
  sanitizeProbeError,
} from '../mcp/mcp-probe.ts'
import { callMcpTool } from '../mcp/mcp-tool-list.ts'
import type { Project } from '../project/projects.ts'
import type { TaskKeyLookupResult } from './task-key-admission.ts'

const errorText = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).split('\n', 1)[0]!.slice(0, 400)

const processEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

export const trackerLookupFailureCondition = (cause: unknown, config: McpServerConfig): string =>
  `tracker lookup failed: ${sanitizeProbeError(errorText(cause), probeSecrets(config))}`

export function classifyHubTaskLookup(
  key: string,
  code: number,
  stdout: string,
  stderr: string,
): TaskKeyLookupResult {
  if (code === 0) return { state: 'found' }
  const detail = stderr.trim() || stdout.trim() || `hub exited ${code}`
  if (detail.split('\n').some((line) => line.trim() === `no task ${key}`)) {
    return { state: 'not-found' }
  }
  return { state: 'unreachable', condition: errorText(detail) }
}

async function lookupHubTask(project: Project, key: string): Promise<TaskKeyLookupResult> {
  try {
    const child = Bun.spawn(
      [...bottegaEntryArgv('hub'), 'task', 'show', key, '--project', project.name, '--json'],
      { cwd: project.path, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return classifyHubTaskLookup(key, code, stdout, stderr)
  } catch (cause) {
    return { state: 'unreachable', condition: `hub task lookup failed: ${errorText(cause)}` }
  }
}

async function lookupRemoteTask(project: Project, key: string): Promise<TaskKeyLookupResult> {
  const source = trackerSourceFor(project)
  if (!source?.lookup) {
    return {
      state: 'unreachable',
      condition: `tracker protocol ${project.settings.tracker?.protocol ?? '(missing)'} has no task lookup adapter`,
    }
  }
  const server = project.settings.mcpServer ?? project.name
  const config = readMcpConfig(project.path)[server]
  if (!config) {
    return {
      state: 'unreachable',
      condition: `MCP server ${server} is not configured in ${project.path}/.mcp.json`,
    }
  }
  try {
    const task = await source.lookup(
      {
        callTool: (name, args) =>
          callMcpTool(
            {
              command: config.command,
              args: config.args,
              cwd: project.path,
              url: config.url,
              headers: config.headers,
              env: config.env,
            },
            processEnvironment(),
            name,
            args,
          ),
      },
      key,
    )
    return task ? { state: 'found' } : { state: 'not-found' }
  } catch (cause) {
    return {
      state: 'unreachable',
      condition: trackerLookupFailureCondition(cause, config),
    }
  }
}

export async function lookupProjectTaskKey(
  project: Project,
  key: string,
): Promise<TaskKeyLookupResult> {
  return project.settings.tracker?.protocol === 'hub'
    ? lookupHubTask(project, key)
    : lookupRemoteTask(project, key)
}
