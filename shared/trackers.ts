import { z } from 'zod'

export type StatusCategory = 'open' | 'active' | 'review' | 'done' | 'dropped'
export const TASK_STATUSES = ['open', 'active', 'review', 'done', 'dropped'] as const

const TRACKER_ACTIONS = ['search', 'get', 'create', 'update', 'status', 'comment'] as const
export type TrackerAction = (typeof TRACKER_ACTIONS)[number]
export const TRACKER_PROTOCOLS = ['workspace-mcp', 'cursor-mcp', 'array-mcp', 'hub'] as const
export type TrackerProtocol = (typeof TRACKER_PROTOCOLS)[number]
type TrackerActionName = { agent: string; wire?: string }

/** The names agents and hub use for each protocol capability. */
const trackerProtocolActions = {
  'workspace-mcp': {
    search: { agent: 'list-tasks-tool' },
    get: { agent: 'get-task-tool' },
    create: { agent: 'create-task-tool' },
    update: { agent: 'update-task-tool' },
    status: { agent: 'update-task-tool' },
    comment: { agent: 'create-task-comment-tool' },
  },
  'cursor-mcp': {
    search: { agent: 'task_list', wire: 'task.list' },
    get: { agent: 'task_getByKey', wire: 'task.getByKey' },
    create: { agent: 'task_create', wire: 'task.create' },
    update: { agent: 'task_update', wire: 'task.update' },
    status: { agent: 'task_update', wire: 'task.update' },
    comment: { agent: 'comment_add', wire: 'comment.add' },
  },
  'array-mcp': {
    search: { agent: 'task_list' },
    // The server has no single-task read; arrayMcpSource.lookup reads one by key
    // through a task_list search, so that is its get.
    get: { agent: 'task_list' },
    create: { agent: 'task_create' },
    update: { agent: 'task_update' },
    // task_update takes status as a plain field; task_move also needs a board rank.
    status: { agent: 'task_update' },
  },
  hub: {
    search: { agent: 'hub task list --project {project}' },
    get: { agent: 'hub task show {key}' },
    create: { agent: 'hub task new --project {project}' },
    update: { agent: 'hub task set {key}' },
    status: { agent: 'hub task set {key} --status' },
    comment: { agent: 'hub task comment {key}' },
  },
} satisfies Record<TrackerProtocol, Partial<Record<TrackerAction, TrackerActionName>>>

export const trackerWireAction = (protocol: TrackerProtocol, action: TrackerAction): string => {
  const actions: Record<
    TrackerProtocol,
    Partial<Record<TrackerAction, TrackerActionName>>
  > = trackerProtocolActions
  const name = actions[protocol][action]
  if (!name) throw new Error(`tracker protocol ${protocol} has no ${action} action`)
  return name.wire ?? name.agent
}

/**
 * Agent-facing capability names, with register overrides replacing protocol
 * defaults. Hub commands are fixed, so a hub override is never applied, even
 * from a settings row that reached the store without register validation.
 */
export function resolveTrackerAgentActions(
  protocol: TrackerProtocol,
  requested: Partial<Record<TrackerAction, string>> = {},
): Partial<Record<TrackerAction, string>> {
  const overrides = protocol === 'hub' ? {} : requested
  const defaults: Record<
    TrackerProtocol,
    Partial<Record<TrackerAction, TrackerActionName>>
  > = trackerProtocolActions
  return {
    ...Object.fromEntries(
      Object.entries(defaults[protocol]).map(([action, name]) => [action, name.agent]),
    ),
    ...overrides,
  }
}

// A tracker kind and its state names are written into workflow steps an agent
// follows, so they are plain names with no shell syntax.
const trackerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, 'must be a plain name: letters, digits, space, _ . -')

const trackerActionsShape = Object.fromEntries(
  TRACKER_ACTIONS.map((action) => [
    action,
    z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+$/, 'must be a plain MCP tool name')
      .optional(),
  ]),
) as { [Action in TrackerAction]: z.ZodOptional<z.ZodString> }

export const trackerSettingsShape = {
  kind: trackerNameSchema.optional(),
  protocol: z.string().trim().min(1).optional(),
  team: z.string().trim().min(1).optional(),
  assigneeLookup: z.enum(['person-lookup', 'task-detail']).optional(),
  envPrefix: z.string().trim().min(1).optional(),
  openStatuses: z.array(z.string()).optional(),
  states: z.record(trackerNameSchema, z.enum(['backlog', ...TASK_STATUSES])).optional(),
  actions: z.strictObject(trackerActionsShape).optional(),
}

export type TrackerSettings = z.infer<z.ZodObject<typeof trackerSettingsShape>>

/** Hub commands are fixed; only MCP tool names may be overridden. */
export function refuseHubActionOverrides(
  tracker: TrackerSettings,
  context: z.core.$RefinementCtx<TrackerSettings>,
): void {
  if (tracker.protocol === 'hub' && tracker.actions !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['actions'],
      message: 'hub protocol accepts no action overrides; remove tracker.actions',
    })
  }
}

export type TrackerProject = {
  name: string
  settings: {
    envPrefix?: string
    tracker?: TrackerSettings
    [key: string]: unknown
  }
}

export type TrackerRowSource = 'local' | 'mcp' | 'git'
type Capability = { allowed: true } | { allowed: false; reason: string }
export type Capabilities = {
  create: Capability
  setStatus: Capability
  setTitle: Capability
  comment: Capability
  documents: Capability
  statusVocabulary: string[] | null
  keyFormat: string | null
}

export const CURSOR_CREATE_REFUSAL =
  'cursor-mcp create refused: required projectId has no value in the tracker register'
export const TRACKER_STATUS_WRITE_REFUSAL =
  'No adapter has proven a status write to this tracker; hub refuses to guess a payload.'
export const TRACKER_TITLE_WRITE_REFUSAL =
  'No adapter has proven a title write to this tracker; hub refuses to guess a payload.'
export const TRACKER_COMMENT_WRITE_REFUSAL =
  'No adapter has proven a comment write to this tracker; hub refuses to guess a payload.'
export const GIT_WRITE_REFUSAL = 'Derived from git history; there is no tracker to write to.'
export const UNKNOWN_TRACKER_REFUSAL =
  "This record's project is not registered on this machine (or declares no tracker protocol), so hub cannot establish what its tracker accepts."

const allow: Capability = { allowed: true }
const refuse = (reason: string): Capability => ({ allowed: false, reason })
export const documentsRefusal = (protocol: string): string =>
  `Documents are hub-native; this record lives in ${protocol} and carries none.`
const workspaceTeamRefusal = (project: TrackerProject): string =>
  `workspace-mcp create refused: project ${project.name} tracker is missing team; ` +
  `set it with: orch project set ${project.name} --settings '{"tracker":{"team":"…"}}'`

const keyFormat = (project: TrackerProject | null): string | null => {
  const prefixes = project?.settings.keyPrefixes
  return Array.isArray(prefixes) && prefixes.length
    ? prefixes.map((prefix) => `${prefix}-*`).join(' | ')
    : null
}

/** Protocol facts for one served row. Unknown provenance stays readable and read-only. */
export function trackerCapabilities({
  source,
  project,
}: {
  source: TrackerRowSource
  project: TrackerProject | null
}): Capabilities {
  if (source === 'local') {
    return {
      create: allow,
      setStatus: allow,
      setTitle: allow,
      comment: allow,
      documents: allow,
      statusVocabulary: [...TASK_STATUSES],
      keyFormat: keyFormat(project),
    }
  }
  const protocol = project?.settings.tracker?.protocol
  if (!project || !protocol) {
    return {
      create: refuse(UNKNOWN_TRACKER_REFUSAL),
      setStatus: refuse(UNKNOWN_TRACKER_REFUSAL),
      setTitle: refuse(UNKNOWN_TRACKER_REFUSAL),
      comment: refuse(UNKNOWN_TRACKER_REFUSAL),
      documents: refuse(UNKNOWN_TRACKER_REFUSAL),
      statusVocabulary: null,
      keyFormat: null,
    }
  }
  if (source === 'git') {
    return {
      create: refuse(GIT_WRITE_REFUSAL),
      setStatus: refuse(GIT_WRITE_REFUSAL),
      setTitle: refuse(GIT_WRITE_REFUSAL),
      comment: refuse(GIT_WRITE_REFUSAL),
      documents: refuse(GIT_WRITE_REFUSAL),
      statusVocabulary: null,
      keyFormat: keyFormat(project),
    }
  }
  if (!['workspace-mcp', 'cursor-mcp', 'array-mcp'].includes(protocol)) {
    return {
      create: refuse(UNKNOWN_TRACKER_REFUSAL),
      setStatus: refuse(UNKNOWN_TRACKER_REFUSAL),
      setTitle: refuse(UNKNOWN_TRACKER_REFUSAL),
      comment: refuse(UNKNOWN_TRACKER_REFUSAL),
      documents: refuse(UNKNOWN_TRACKER_REFUSAL),
      statusVocabulary: null,
      keyFormat: null,
    }
  }
  return {
    create:
      protocol === 'array-mcp' ||
      (protocol === 'workspace-mcp' && Boolean(project.settings.tracker?.team))
        ? allow
        : refuse(
            protocol === 'workspace-mcp' ? workspaceTeamRefusal(project) : CURSOR_CREATE_REFUSAL,
          ),
    setStatus: refuse(TRACKER_STATUS_WRITE_REFUSAL),
    setTitle: refuse(TRACKER_TITLE_WRITE_REFUSAL),
    comment: refuse(TRACKER_COMMENT_WRITE_REFUSAL),
    documents: refuse(documentsRefusal(protocol)),
    statusVocabulary: project?.settings.tracker?.states
      ? Object.keys(project.settings.tracker.states)
      : null,
    keyFormat: keyFormat(project),
  }
}

export type ToolCaller = {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

export type TrackerTask = {
  key: string
  project: string
  title: string
  status: string
  category: StatusCategory
  updatedAt: string | null
  assignee: string | null
}

export type AssigneeRef = {
  id?: string | number | null
  name?: string | null
  taskKey?: string
}

export type AssigneeResolver = (
  namespace: string,
  refs: AssigneeRef[],
  lookup: (id: string, taskKey?: string) => Promise<string | null>,
) => Promise<(string | null)[]>

export type TrackerSource = {
  project: string
  /** The env-source name prefix, e.g. STARSHIP for STARSHIP_MCP_URL. */
  env: string
  fetch: (m: ToolCaller) => Promise<TrackerTask[]>
  /** One closed task by key, for work the window touched but the sync skipped. */
  lookup?: (m: ToolCaller, key: string) => Promise<TrackerTask | null>
}

export type CreateTrackerTask = {
  title: string
  body: string
  status: string
}

export type ToolInputSchema = {
  properties?: Record<string, unknown>
}

/**
 * Open work is fetched in full; closed work is looked up by key only when a
 * caller needs it. Enough pages to hold any project's open work, with a stop so
 * nothing spins.
 */
const MAX_PAGES = 40

/** The raw status word wins where it is finer than the tracker's category. */
function categoryOf(
  rawStatus: string,
  category: string,
  states: TrackerSettings['states'],
): StatusCategory {
  const w = rawStatus.toLowerCase()
  if (/review/.test(w)) return 'review'
  if (/blocked|on hold/.test(w)) return 'review'
  const normal = (value: string) => value.toLowerCase().replace(/[ -]+/g, '_')
  const mapped =
    states?.[rawStatus] ??
    states?.[normal(rawStatus)] ??
    states?.[category] ??
    states?.[normal(category)]
  return mapped === 'backlog' ? 'open' : (mapped ?? 'open')
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)

/** Resolve each new id once. A cached null is a known failed resolution, not a miss. */
export async function resolveAssigneeIds(
  refs: AssigneeRef[],
  cache: Map<string, string | null>,
  lookup: (id: string, taskKey?: string) => Promise<string | null>,
): Promise<(string | null)[]> {
  for (const ref of refs) {
    if (ref.id == null || ref.name?.trim()) continue
    const id = String(ref.id)
    if (!cache.has(id)) {
      try {
        cache.set(id, await lookup(id, ref.taskKey))
      } catch {
        cache.set(id, null)
      }
    }
  }
  return refs.map((ref) => {
    const direct = ref.name?.trim()
    if (direct) return direct
    return ref.id == null ? null : (cache.get(String(ref.id)) ?? null)
  })
}

const uncachedAssignees: AssigneeResolver = (_namespace, refs, lookup) =>
  resolveAssigneeIds(refs, new Map(), lookup)

function workspaceSource(
  project: string,
  env: string,
  openStatuses: string[],
  states: TrackerSettings['states'],
  lookup: NonNullable<TrackerSettings['assigneeLookup']>,
  resolveAssignees: AssigneeResolver,
): TrackerSource {
  const assignees = (m: ToolCaller, refs: AssigneeRef[]) =>
    resolveAssignees(project, refs, async (id, taskKey) => {
      if (lookup === 'task-detail' && taskKey) {
        const detail = (await m.callTool(trackerWireAction('workspace-mcp', 'get'), {
          id: taskKey,
        })) as {
          assignee?: string | null
          assignee_id?: string | number | null
        }
        return String(detail.assignee_id) === id ? detail.assignee?.trim() || null : null
      }
      const person = (await m.callTool('person-lookup-tool', { id })) as { name?: string | null }
      return person.name?.trim() || null
    })
  return {
    project,
    env,
    async fetch(m) {
      const out: TrackerTask[] = []
      const refs: AssigneeRef[] = []
      for (const status of openStatuses) {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const r = (await m.callTool(trackerWireAction('workspace-mcp', 'search'), {
            status,
            page,
            per_page: 100,
          })) as {
            tasks?: {
              short_id?: string
              summary?: string
              status?: string
              status_category?: string
              assignee_id?: string | number | null
            }[]
            last_page?: number
          }
          for (const t of r.tasks ?? []) {
            if (!t.short_id) continue
            out.push({
              key: t.short_id.toUpperCase(),
              project,
              title: decode(t.summary ?? ''),
              status: t.status ?? status,
              category: categoryOf(t.status ?? '', t.status_category ?? status, states),
              updatedAt: null,
              assignee: null,
            })
            refs.push({ id: t.assignee_id, taskKey: t.short_id.toUpperCase() })
          }
          if (!r.last_page || page >= r.last_page) break
        }
      }
      const names = await assignees(m, refs)
      out.forEach((task, index) => {
        task.assignee = names[index] ?? null
      })
      return out
    },
    async lookup(m, key) {
      const r = (await m.callTool(trackerWireAction('workspace-mcp', 'search'), {
        search: key,
        per_page: 5,
      })) as {
        tasks?: {
          short_id?: string
          summary?: string
          status?: string
          status_category?: string
          assignee_id?: string | number | null
        }[]
      }
      const hit = (r.tasks ?? []).find((t) => t.short_id?.toUpperCase() === key)
      if (!hit) return null
      const [assignee] = await assignees(m, [{ id: hit.assignee_id, taskKey: key }])
      return {
        key,
        project,
        title: decode(hit.summary ?? ''),
        status: hit.status ?? '',
        category: categoryOf(hit.status ?? '', hit.status_category ?? 'completed', states),
        updatedAt: null,
        assignee: assignee ?? null,
      }
    },
  }
}

/**
 * Dotted tool names (`task.list`) with a `{data:{items,nextCursor}}` envelope,
 * paged by cursor. The dot is the server's wire name even when clients display
 * it as an underscore.
 */
function cursorMcpSource(
  project: string,
  env: string,
  openStatuses: string[],
  states: TrackerSettings['states'],
): TrackerSource {
  return {
    project,
    env,
    async fetch(m) {
      const out: TrackerTask[] = []
      for (const status of openStatuses) {
        let cursor: string | undefined
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = (await m.callTool(trackerWireAction('cursor-mcp', 'search'), {
            status,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          })) as {
            data?: {
              items?: {
                humanKey?: string
                title?: string
                status?: string
                updatedAt?: string
                assigneeName?: string | null
              }[]
              nextCursor?: string
            }
          }
          for (const t of r.data?.items ?? []) {
            if (!t.humanKey) continue
            out.push({
              key: t.humanKey.toUpperCase(),
              project,
              title: decode(t.title ?? ''),
              status: t.status ?? status,
              category: categoryOf(t.status ?? '', t.status ?? status, states),
              updatedAt: t.updatedAt ?? null,
              assignee: t.assigneeName?.trim() || null,
            })
          }
          cursor = r.data?.nextCursor
          if (!cursor) break
        }
      }
      return out
    },
    async lookup(m, key) {
      const r = (await m.callTool(trackerWireAction('cursor-mcp', 'get'), { taskKey: key })) as {
        data?: {
          humanKey?: string
          title?: string
          status?: string
          updatedAt?: string
          assigneeName?: string | null
        }
      }
      const t = r.data
      if (!t?.humanKey) return null
      return {
        key,
        project,
        title: decode(t.title ?? ''),
        status: t.status ?? '',
        category: categoryOf(t.status ?? '', t.status ?? 'done', states),
        updatedAt: t.updatedAt ?? null,
        assignee: t.assigneeName?.trim() || null,
      }
    },
  }
}

/**
 * Underscore tool names (`task_list`) with a bare-array reply. Some servers
 * carry these tools only on their platform origin, so the configured endpoint
 * must be that origin.
 */
function arrayMcpSource(
  project: string,
  env: string,
  openStatuses: string[],
  states: TrackerSettings['states'],
): TrackerSource {
  return {
    project,
    env,
    async fetch(m) {
      const out: TrackerTask[] = []
      for (const status of openStatuses) {
        const r = (await m.callTool(trackerWireAction('array-mcp', 'search'), { status })) as {
          key?: string
          title?: string
          status?: string
          assigneeName?: string | null
        }[]
        for (const t of Array.isArray(r) ? r : []) {
          if (!t.key) continue
          out.push({
            key: t.key.toUpperCase(),
            project,
            title: decode(t.title ?? ''),
            status: t.status ?? status,
            category: categoryOf(t.status ?? '', t.status ?? status, states),
            updatedAt: null,
            assignee: t.assigneeName?.trim() || null,
          })
        }
      }
      return out
    },
    async lookup(m, key) {
      const r = (await m.callTool(trackerWireAction('array-mcp', 'get'), { search: key })) as {
        key?: string
        title?: string
        status?: string
        updatedAt?: string
        assigneeName?: string | null
      }[]
      const hit = (Array.isArray(r) ? r : []).find((t) => t.key?.toUpperCase() === key)
      if (!hit) return null
      return {
        key,
        project,
        title: decode(hit.title ?? ''),
        status: hit.status ?? '',
        category: categoryOf(hit.status ?? '', hit.status ?? 'done', states),
        updatedAt: hit.updatedAt ?? null,
        assignee: hit.assigneeName?.trim() || null,
      }
    },
  }
}

export function trackerSourceFor(
  project: TrackerProject,
  resolveAssignees: AssigneeResolver = uncachedAssignees,
): TrackerSource | null {
  const tracker = project.settings.tracker
  if (!tracker) return null
  if (tracker.protocol === 'hub') return null
  const protocols = ['workspace-mcp', 'cursor-mcp', 'array-mcp']
  if (!tracker.protocol || !protocols.includes(tracker.protocol)) {
    throw new Error(
      `project ${project.name} tracker has unrecognised protocol ${tracker.protocol ?? '(missing)'}`,
    )
  }
  const env = tracker.envPrefix ?? project.settings.envPrefix
  if (!env) {
    throw new Error(`project ${project.name} tracker is missing envPrefix`)
  }
  const statuses = tracker.openStatuses ?? []
  if (tracker.protocol === 'workspace-mcp') {
    return workspaceSource(
      project.name,
      env,
      statuses,
      tracker.states,
      tracker.assigneeLookup ?? 'person-lookup',
      resolveAssignees,
    )
  }
  if (tracker.protocol === 'cursor-mcp') {
    return cursorMcpSource(project.name, env, statuses, tracker.states)
  }
  if (tracker.protocol === 'array-mcp') {
    return arrayMcpSource(project.name, env, statuses, tracker.states)
  }
  // Exhaustive above; kept explicit so a future protocol cannot silently build nothing.
  throw new Error(`project ${project.name} tracker has unrecognised protocol ${tracker.protocol}`)
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
    if (!tracker.team) {
      throw new Error(workspaceTeamRefusal(project))
    }
    return m.callTool(tracker.actions?.create ?? trackerWireAction('workspace-mcp', 'create'), {
      ...workspaceCreatePayload(task, tracker.team, Object.keys(inputSchema?.properties ?? {})),
    })
  }
  if (tracker.protocol === 'cursor-mcp') {
    // Its tool schema requires projectId; the register carries no tracker field
    // from which that UUID can be obtained.
    throw new Error(CURSOR_CREATE_REFUSAL)
  }
  if (tracker.protocol === 'array-mcp') {
    // The reflected task.create schema establishes these names; the MCP bridge
    // exposes its dotted procedure name on the wire with an underscore.
    return m.callTool(trackerWireAction('array-mcp', 'create'), {
      title: task.title,
      description: task.body,
      status: task.status,
    })
  }
  throw new Error(`tracker protocol ${tracker.protocol ?? '(missing)'} has no create support`)
}
