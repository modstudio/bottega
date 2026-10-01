import {
  type CreateTrackerTask,
  createTrackerTask,
  type ToolCaller,
  type TrackerProject,
  type TrackerProtocol,
  trackerCreatedTaskKey,
  trackerWireAction,
} from '../../shared/trackers.ts'
import { projectHasRemoteTracker } from './hosted-write-mode.ts'
import type { McpTool } from './mcp.ts'

type ToolListingCaller = ToolCaller & {
  listTools(): Promise<McpTool[]>
}

export type TaskCreationDestination = 'tracker' | 'hosted'

/** Decide which system owns creation and therefore the task key. */
export function taskCreationDestination(project: TrackerProject): TaskCreationDestination {
  return projectHasRemoteTracker(project.settings.tracker) ? 'tracker' : 'hosted'
}

export function trackerTaskInput(
  project: TrackerProject,
  input: { title: string; body?: string; status?: string; parent?: string },
): CreateTrackerTask {
  const tracker = project.settings.tracker
  if (!tracker) throw new Error(`project ${project.name} has no tracker configured`)
  if (input.parent)
    throw new Error(
      `--parent is not supported for project ${project.name}; set the parent in the ${tracker.kind ?? tracker.protocol ?? 'project'} tracker`,
    )
  const mapped = Object.entries(tracker.states ?? {})
  const status = input.status
    ? mapped.find(([, category]) => category === input.status)?.[0]
    : tracker.openStatuses?.[0]
  if (!status) {
    const choices = mapped.map(([name, category]) => `${category} -> ${name}`).join(', ')
    throw new Error(
      input.status
        ? `status '${input.status}' does not map to a tracker status for project ${project.name}; mapped statuses: ${choices || '(none)'}`
        : `project ${project.name} has no open tracker status configured`,
    )
  }
  return { title: input.title, body: input.body ?? '', status }
}

export async function createAdvertisedTrackerTaskKey(
  client: ToolListingCaller,
  project: TrackerProject,
  task: CreateTrackerTask,
): Promise<string> {
  const result = await createAdvertisedTrackerTask(client, project, task)
  const protocol = project.settings.tracker?.protocol
  const key = protocol ? trackerCreatedTaskKey(protocol as TrackerProtocol, result) : null
  if (!key)
    throw new Error(`tracker created a task but returned no task key: ${JSON.stringify(result)}`)
  return key
}

/** Create only through the schema advertised by the selected, initialized MCP server. */
export async function createAdvertisedTrackerTask(
  client: ToolListingCaller,
  project: TrackerProject,
  task: CreateTrackerTask,
): Promise<unknown> {
  const tracker = project.settings.tracker
  if (!tracker) throw new Error(`project ${project.name} has no tracker configured`)
  const createToolName =
    tracker.actions?.create ??
    (tracker.protocol === 'workspace-mcp' ||
    tracker.protocol === 'cursor-mcp' ||
    tracker.protocol === 'array-mcp'
      ? trackerWireAction(tracker.protocol, 'create')
      : null)
  if (!createToolName)
    throw new Error(`tracker protocol ${tracker.protocol ?? '(missing)'} has no create support`)
  const createTool = (await client.listTools()).find((tool) => tool.name === createToolName)
  if (!createTool) throw new Error(`tracker create tool ${createToolName} was not advertised`)
  return createTrackerTask(client, project, task, createTool.inputSchema)
}
