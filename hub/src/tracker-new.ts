import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  type CreateTrackerTask,
  createTrackerTask,
  trackerCreatedTaskKey,
} from '../../shared/tracker-create.ts'
import { advertisedToolSchema, type ToolListingCaller } from '../../shared/tracker-list-scope.ts'
import {
  resolveTrackerWriteState,
  type TrackerProject,
  type TrackerProtocol,
  trackerWireAction,
  trackerWriteCategory,
} from '../../shared/trackers.ts'
import { projectHasRemoteTracker } from './hosted-write-mode.ts'

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
  const requested = input.status
  const category = trackerWriteCategory(tracker, requested ?? 'open')
  const status = category
    ? resolveTrackerWriteState(project.name, tracker, tracker.protocol as TrackerProtocol, category)
    : undefined
  if (!status) {
    const choices = mapped.map(([name, category]) => `${category} -> ${name}`).join(', ')
    throw new Error(
      input.status
        ? `status '${input.status}' does not map to a tracker status for project ${project.name}; mapped statuses: ${choices || '(none)'}`
        : `project ${project.name} has no writable open tracker status; configure tracker.writeStates.open and tracker.states with: ${PLATFORM_SLUG} project set ${project.name} --settings '${JSON.stringify({ tracker: { states: { '<open-state>': 'open' }, writeStates: { open: '<open-state>' } } })}'`,
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
  const inputSchema = await advertisedToolSchema(client, createToolName)
  if (!inputSchema) throw new Error(`tracker create tool ${createToolName} was not advertised`)
  return createTrackerTask(client, project, task, inputSchema)
}
