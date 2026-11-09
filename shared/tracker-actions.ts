import { PLATFORM_SLUG } from './brand.ts'

const TRACKER_ACTIONS = [
  'search',
  'get',
  'create',
  'update',
  'status',
  'comment',
  'list-comments',
  'document',
] as const
export type TrackerAction = (typeof TRACKER_ACTIONS)[number]
export const TRACKER_PROTOCOLS = ['workspace-mcp', 'cursor-mcp', 'array-mcp', 'hub'] as const
export type TrackerProtocol = (typeof TRACKER_PROTOCOLS)[number]
type TrackerActionName = { agent: string; wire?: string | null }

export const isTrackerProtocol = (protocol: unknown): protocol is TrackerProtocol =>
  TRACKER_PROTOCOLS.some((candidate) => candidate === protocol)

/** The names agents and hub use for each protocol capability. */
const trackerProtocolActions: Record<
  TrackerProtocol,
  Partial<Record<TrackerAction, TrackerActionName>>
> = {
  'workspace-mcp': {
    search: { agent: 'list-tasks-tool' },
    get: { agent: 'get-task-tool' },
    create: { agent: 'create-task-tool' },
    update: { agent: 'update-task-tool' },
    status: { agent: 'update-task-tool' },
    comment: { agent: 'create-task-comment-tool' },
    document: { agent: 'create-task-document-tool' },
  },
  'cursor-mcp': {
    search: { agent: 'task_list', wire: 'task.list' },
    get: { agent: 'task_getByKey', wire: 'task.getByKey' },
    create: { agent: 'task_create', wire: 'task.create' },
    update: { agent: 'task_update', wire: 'task.update' },
    status: { agent: 'task_update', wire: 'task.update' },
    comment: { agent: 'comment_add', wire: 'comment.add' },
    'list-comments': { agent: 'comment_list', wire: 'comment.list' },
  },
  'array-mcp': {
    search: { agent: 'task_list' },
    // The server has no single-task read; arrayMcpSource.lookup reads one by key
    // through a task_list search, so that is its get.
    get: { agent: 'task_list' },
    create: { agent: 'task_create' },
    update: { agent: 'task_update' },
    // task_update takes status as a plain field; task_move also needs a board rank.
    status: { agent: `${PLATFORM_SLUG} task set {key} --status`, wire: 'task_update' },
    comment: { agent: `${PLATFORM_SLUG} workflow attach`, wire: null },
    document: { agent: 'task_addDocument' },
  },
  hub: {
    search: { agent: `${PLATFORM_SLUG} task list --project {project}` },
    get: { agent: `${PLATFORM_SLUG} task show {key}` },
    create: { agent: `${PLATFORM_SLUG} task new --project {project}` },
    update: { agent: `${PLATFORM_SLUG} task set {key}` },
    status: { agent: `${PLATFORM_SLUG} task set {key} --status` },
    comment: { agent: `${PLATFORM_SLUG} task comment {key}` },
    document: { agent: `${PLATFORM_SLUG} task doc new {key}` },
  },
}

export const trackerWireAction = (protocol: TrackerProtocol, action: TrackerAction): string => {
  const name = trackerProtocolActions[protocol][action]
  if (!name || name.wire === null)
    throw new Error(`tracker protocol ${protocol} has no ${action} action`)
  return name.wire ?? name.agent
}

/** Agent-facing names, with register overrides replacing non-hub defaults. */
export function resolveTrackerAgentActions(
  protocol: TrackerProtocol,
  requested: Partial<Record<TrackerAction, string>> = {},
): Partial<Record<TrackerAction, string>> {
  const overrides = protocol === 'hub' ? {} : requested
  return {
    ...Object.fromEntries(
      Object.entries(trackerProtocolActions[protocol]).map(([action, name]) => [
        action,
        name.agent,
      ]),
    ),
    ...overrides,
  }
}

export { TRACKER_ACTIONS }
