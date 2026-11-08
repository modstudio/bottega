import {
  cursorProjectRefusal,
  type ToolCaller,
  type TrackerProject,
  type TrackerProtocol,
  trackerWireAction,
  workspaceTeamRefusal,
} from './trackers.ts'

export type CreateTrackerTask = {
  title: string
  body: string
  status: string
}

export type ToolInputSchema = {
  properties?: Record<string, unknown>
}

const nonEmptyUppercase = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.toUpperCase() : undefined

/** Read a created task key only from the field owned by its tracker protocol. */
export function trackerCreatedTaskKey(
  protocol: TrackerProtocol,
  result: unknown,
): string | undefined {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  if (protocol === 'workspace-mcp') return nonEmptyUppercase(record.short_id)
  if (protocol === 'array-mcp') return nonEmptyUppercase(record.key)
  if (protocol === 'cursor-mcp') {
    const data = record.data && typeof record.data === 'object' ? record.data : {}
    return nonEmptyUppercase('humanKey' in data ? data.humanKey : undefined)
  }
  return undefined
}

function assertKnownStatus(project: TrackerProject, status: string): void {
  const tracker = project.settings.tracker!
  const vocabulary = new Set([
    ...(tracker.openStatuses ?? []),
    ...Object.keys(tracker.states ?? {}),
  ])
  if (!vocabulary.size) {
    throw new Error(`project ${project.name} has no tracker status vocabulary configured`)
  }
  if (!vocabulary.has(status)) {
    throw new Error(`status ${status} is not in project ${project.name}'s tracker vocabulary`)
  }
}

function workspaceCreatePayload(
  task: CreateTrackerTask,
  team: string,
  properties: string[],
): Record<string, unknown> {
  const fieldsSeen = () => (properties.length ? [...properties].sort().join(', ') : '(none)')
  const statusFields = properties.filter((field) => ['status', 'task_status_id'].includes(field))
  if (statusFields.length !== 1) {
    throw new Error(
      'workspace-mcp create refused: expected exactly one of status or task_status_id; ' +
        `fields seen: ${fieldsSeen()}`,
    )
  }
  const teamFields = properties.filter((field) => ['team', 'team_id'].includes(field))
  if (teamFields.length !== 1) {
    throw new Error(
      'workspace-mcp create refused: expected exactly one of team or team_id; ' +
        `fields seen: ${fieldsSeen()}`,
    )
  }
  return {
    summary: task.title,
    description: task.body,
    [teamFields[0]!]: team,
    [statusFields[0]!]: task.status,
  }
}

/** Create through a caller whose connection and lifetime remain owned by the caller. */
export async function createTrackerTask(
  m: ToolCaller,
  project: TrackerProject,
  task: CreateTrackerTask,
  inputSchema?: ToolInputSchema,
): Promise<unknown> {
  const tracker = project.settings.tracker
  if (!tracker) throw new Error(`project ${project.name} has no tracker configured`)
  assertKnownStatus(project, task.status)

  if (tracker.protocol === 'workspace-mcp') {
    if (!tracker.team) throw new Error(workspaceTeamRefusal(project))
    return m.callTool(tracker.actions?.create ?? trackerWireAction('workspace-mcp', 'create'), {
      ...workspaceCreatePayload(task, tracker.team, Object.keys(inputSchema?.properties ?? {})),
    })
  }
  if (tracker.protocol === 'cursor-mcp') {
    if (!tracker.projectId) throw new Error(cursorProjectRefusal(project))
    return m.callTool(tracker.actions?.create ?? trackerWireAction('cursor-mcp', 'create'), {
      projectId: tracker.projectId,
      title: task.title,
      description: task.body,
      status: task.status,
    })
  }
  if (tracker.protocol === 'array-mcp') {
    return m.callTool(trackerWireAction('array-mcp', 'create'), {
      title: task.title,
      description: task.body,
      status: task.status,
    })
  }
  throw new Error(`tracker protocol ${tracker.protocol ?? '(missing)'} has no create support`)
}
