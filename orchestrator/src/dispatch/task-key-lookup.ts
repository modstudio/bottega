// concern: task-key-lookup
/** Reads a task through the tracker protocol declared by its registered project. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { trackerSourceFor } from '../../../shared/trackers.ts'
import { resolveProjectMcpCommand } from '../mcp/mcp-command.ts'
import { McpHeadersHelperError, resolveMcpHeaders } from '../mcp/mcp-headers-helper.ts'
import {
  type McpServerConfig,
  probeSecrets,
  readMcpConfig,
  sanitizeProbeError,
} from '../mcp/mcp-probe.ts'
import { callMcpTool } from '../mcp/mcp-tool-list.ts'
import type { Project } from '../project/projects.ts'
import { readTaskThroughCli } from './task-cli-read.ts'
import type { TaskKeyLookupResult } from './task-key-admission.ts'

const errorText = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).split('\n', 1)[0]!.slice(0, 400)

const processEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

export type LensTaskRead =
  | {
      available: true
      recordId: string
      key: string
      title: string
      body: string
      comments: string[]
    }
  | { available: false; reason: string }

/** Read the task text through the CLI capability declared by the project register. */
export async function readLensTask(project: Project, key: string): Promise<LensTaskRead> {
  if (project.settings.tracker?.protocol !== 'hub') {
    return {
      available: false,
      reason:
        "tracker reachable only through the project's MCP; declare a CLI task read in the project register",
    }
  }
  try {
    const result = await readTaskThroughCli(project, key)
    if (result.exitCode !== 0) {
      return {
        available: false,
        reason: errorText(result.stderr || result.stdout || `exit ${result.exitCode}`),
      }
    }
    const shown = JSON.parse(result.stdout) as {
      task?: { record_id?: unknown; key?: unknown; title?: unknown; body?: unknown }
      comments?: Array<{ body?: unknown }>
    }
    if (
      typeof shown.task?.record_id !== 'string' ||
      typeof shown.task.key !== 'string' ||
      typeof shown.task.title !== 'string'
    ) {
      return { available: false, reason: 'CLI task read returned no task text' }
    }
    return {
      available: true,
      recordId: shown.task.record_id,
      key: shown.task.key,
      title: shown.task.title,
      body: typeof shown.task.body === 'string' ? shown.task.body : '',
      comments: (shown.comments ?? []).flatMap((comment) =>
        typeof comment.body === 'string' && comment.body.trim() ? [comment.body.trim()] : [],
      ),
    }
  } catch (cause) {
    return { available: false, reason: errorText(cause) }
  }
}

export const trackerLookupFailureCondition = (cause: unknown, config: McpServerConfig): string => {
  const detail = sanitizeProbeError(errorText(cause), probeSecrets(config))
  return cause instanceof McpHeadersHelperError ? detail : `tracker lookup failed: ${detail}`
}

export function classifyHubTaskLookup(
  key: string,
  code: number,
  stdout: string,
  stderr: string,
): TaskKeyLookupResult {
  if (code === 0) return { state: 'found' }
  const detail = stderr.trim() || stdout.trim() || `${PLATFORM_SLUG} exited ${code}`
  if (detail.split('\n').some((line) => line.trim() === `no task ${key}`)) {
    return { state: 'not-found' }
  }
  return { state: 'unreachable', condition: errorText(detail) }
}

async function lookupHubTask(project: Project, key: string): Promise<TaskKeyLookupResult> {
  try {
    const child = Bun.spawn(
      [
        ...bottegaEntryArgv(PLATFORM_SLUG),
        'task',
        'show',
        key,
        '--project',
        project.name,
        '--json',
      ],
      { cwd: project.path, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return classifyHubTaskLookup(key, code, stdout, stderr)
  } catch (cause) {
    return {
      state: 'unreachable',
      condition: `${PLATFORM_SLUG} task lookup failed: ${errorText(cause)}`,
    }
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
  let credentialConfig = config
  try {
    const task = await source.lookup(
      {
        callTool: async (name, args) => {
          const environment = processEnvironment()
          const headers = config.url
            ? await resolveMcpHeaders(config, project.path, environment)
            : config.headers
          credentialConfig = { ...config, headers }
          return callMcpTool(
            {
              command: config.command
                ? resolveProjectMcpCommand(config.command, project.path)
                : undefined,
              args: config.args,
              cwd: project.path,
              url: config.url,
              headers,
              env: config.env,
            },
            environment,
            name,
            args,
          )
        },
      },
      key,
    )
    return task ? { state: 'found' } : { state: 'not-found' }
  } catch (cause) {
    return {
      state: 'unreachable',
      condition: trackerLookupFailureCondition(cause, credentialConfig),
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
