import {
  type CreateTrackerTask,
  createTrackerTask,
  type ToolCaller,
  type TrackerProject,
  trackerWireAction,
} from '../../shared/trackers.ts'
import type { McpTool } from './mcp.ts'

type ToolListingCaller = ToolCaller & {
  listTools(): Promise<McpTool[]>
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
