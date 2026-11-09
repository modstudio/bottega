// concern: task-key-lookup
/** Reads a task through the tracker protocol declared by its registered project. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { namesMissingTask } from '../../../shared/task-missing.ts'
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
import { type HubTaskReader, resolveHubTaskReference } from '../workflow/workflow-task-reference.ts'
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

export type TaskTextRead =
  | {
      available: true
      recordId: string | null
      key: string
      title: string
      body: string
      comments: string[]
    }
  | { available: false; reason: string }

async function readHubTaskText(project: Project, key: string): Promise<TaskTextRead> {
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

type RemoteCaller = {
  caller: { callTool(name: string, args: Record<string, unknown>): Promise<unknown> }
  credentialConfig: () => McpServerConfig
}

function remoteTrackerCaller(project: Project): RemoteCaller | null {
  const server = project.settings.mcpServer ?? project.name
  const config = readMcpConfig(project.path)[server]
  if (!config) return null
  let credentials = config
  return {
    credentialConfig: () => credentials,
    caller: {
      callTool: async (name, args) => {
        const environment = processEnvironment()
        const headers = config.url
          ? await resolveMcpHeaders(config, project.path, environment)
          : config.headers
        credentials = { ...config, headers }
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
  }
}

/** Read task text through the tracker declared by the project register. */
export async function readTaskText(
  project: Project,
  key: string,
  dependencies: {
    toolCaller?: { callTool(name: string, args: Record<string, unknown>): Promise<unknown> }
    hubTaskReader?: HubTaskReader
  } = {},
): Promise<TaskTextRead> {
  if (project.settings.tracker?.protocol === 'hub') return readHubTaskText(project, key)
  const source = trackerSourceFor(project)
  if (!source?.readText) {
    return {
      available: false,
      reason: `tracker protocol ${project.settings.tracker?.protocol ?? '(missing)'} has no task text adapter`,
    }
  }
  const remote = dependencies.toolCaller ? null : remoteTrackerCaller(project)
  if (!dependencies.toolCaller && !remote) {
    const server = project.settings.mcpServer ?? project.name
    return {
      available: false,
      reason: `MCP server ${server} is not configured in ${project.path}/.mcp.json`,
    }
  }
  try {
    const task = await source.readText(dependencies.toolCaller ?? remote!.caller, key)
    if (!task) return { available: false, reason: `tracker has no task ${key}` }
    const mirror = await resolveHubTaskReference(project.name, key, dependencies.hubTaskReader)
    return {
      available: true,
      recordId: mirror?.record_id ?? null,
      key: task.key,
      title: task.title,
      body: task.body,
      comments: task.comments,
    }
  } catch (cause) {
    return {
      available: false,
      reason: remote
        ? trackerLookupFailureCondition(cause, remote.credentialConfig())
        : `tracker lookup failed: ${errorText(cause)}`,
    }
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
  if (namesMissingTask(detail, key)) {
    return { state: 'not-found' }
  }
  return { state: 'unreachable', condition: errorText(detail) }
}

async function lookupHubTask(project: Project, key: string): Promise<TaskKeyLookupResult> {
  try {
    const result = await readTaskThroughCli(project, key)
    return classifyHubTaskLookup(key, result.exitCode, result.stdout, result.stderr)
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
  const remote = remoteTrackerCaller(project)
  if (!remote) {
    const server = project.settings.mcpServer ?? project.name
    return {
      state: 'unreachable',
      condition: `MCP server ${server} is not configured in ${project.path}/.mcp.json`,
    }
  }
  try {
    const task = await source.lookup(remote.caller, key)
    return task ? { state: 'found' } : { state: 'not-found' }
  } catch (cause) {
    return {
      state: 'unreachable',
      condition: trackerLookupFailureCondition(cause, remote.credentialConfig()),
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
