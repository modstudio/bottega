export type StatusCategory = 'open' | 'active' | 'review' | 'done' | 'dropped'
export const TASK_STATUSES = ['open', 'active', 'review', 'done', 'dropped'] as const

export type TrackerSettings = {
  kind?: string
  protocol?: 'workspace-mcp' | 'cursor-mcp' | 'array-mcp' | string
  assigneeLookup?: 'person-lookup' | 'task-detail'
  envPrefix?: string
  openStatuses?: string[]
  states?: Record<string, 'backlog' | StatusCategory>
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
export type CapabilityName = 'create' | 'setStatus' | 'setTitle' | 'comment' | 'documents'
export type Capabilities = {
  create: boolean
  setStatus: boolean
  setTitle: boolean
  comment: boolean
  documents: boolean
  statusVocabulary: string[] | null
  keyFormat: string | null
  reasons: Partial<Record<CapabilityName, string>>
}

export const WORKSPACE_CREATE_REFUSAL =
  'workspace-mcp create refused: the status field differs between evidenced tool schemas'
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

const keyFormat = (project: TrackerProject | null): string | null => {
  const prefixes = project?.settings.keyPrefixes
  return Array.isArray(prefixes) && prefixes.length
    ? prefixes.map((prefix) => `${prefix}-*`).join(' | ')
    : null
}

/** Protocol facts for one served row. Unknown provenance stays readable and read-only. */
export function trackerCapabilities({ source, project }: {
  source: TrackerRowSource
  project: TrackerProject | null
}): Capabilities {
  if (source === 'local') {
    return {
      create: true, setStatus: true, setTitle: true, comment: true, documents: true,
      statusVocabulary: [...TASK_STATUSES],
      keyFormat: keyFormat(project), reasons: {},
    }
  }
  if (source === 'git') {
    return {
      create: false, setStatus: false, setTitle: false, comment: false, documents: false,
      statusVocabulary: null, keyFormat: keyFormat(project),
      reasons: Object.fromEntries(
        ['create', 'setStatus', 'setTitle', 'comment', 'documents']
          .map((name) => [name, GIT_WRITE_REFUSAL]),
      ) as Capabilities['reasons'],
    }
  }

  const protocol = project?.settings.tracker?.protocol
  if (!protocol || !['workspace-mcp', 'cursor-mcp', 'array-mcp'].includes(protocol)) {
    return {
      create: false, setStatus: false, setTitle: false, comment: false, documents: false,
      statusVocabulary: null, keyFormat: null,
      reasons: Object.fromEntries(
        ['create', 'setStatus', 'setTitle', 'comment', 'documents']
          .map((name) => [name, UNKNOWN_TRACKER_REFUSAL]),
      ) as Capabilities['reasons'],
    }
  }
  const create = protocol === 'array-mcp'
  return {
    create, setStatus: false, setTitle: false, comment: false, documents: false,
    statusVocabulary: project?.settings.tracker?.states
      ? Object.keys(project.settings.tracker.states)
      : null,
    keyFormat: keyFormat(project),
    reasons: {
      ...(!create ? { create: protocol === 'workspace-mcp'
        ? WORKSPACE_CREATE_REFUSAL : CURSOR_CREATE_REFUSAL } : {}),
      setStatus: TRACKER_STATUS_WRITE_REFUSAL,
      setTitle: TRACKER_TITLE_WRITE_REFUSAL,
      comment: TRACKER_COMMENT_WRITE_REFUSAL,
      documents: `Documents are hub-native; this record lives in ${protocol} and carries none.`,
    },
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
  /** The name in ~/.claude/.env, e.g. STARSHIP_MCP_URL. */
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

/**
 * Open work is fetched in full; closed work is looked up by key only when a
 * caller needs it. Enough pages to hold any project's open work, with a stop so
 * nothing spins.
 */
const MAX_PAGES = 40

/** The raw status word wins where it is finer than the tracker's category. */
function categoryOf(
  rawStatus: string, category: string, states: TrackerSettings['states'],
): StatusCategory {
  const w = rawStatus.toLowerCase()
  if (/review/.test(w)) return 'review'
  if (/blocked|on hold/.test(w)) return 'review'
  const normal = (value: string) => value.toLowerCase().replace(/[ -]+/g, '_')
  const mapped = states?.[rawStatus] ?? states?.[normal(rawStatus)]
    ?? states?.[category] ?? states?.[normal(category)]
  return mapped === 'backlog' ? 'open' : mapped ?? 'open'
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
}
const decode = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)

/** Resolve each new id once. A cached null is a known failed resolution, not a miss. */
export async function resolveAssigneeIds(
  refs: AssigneeRef[], cache: Map<string, string | null>,
  lookup: (id: string, taskKey?: string) => Promise<string | null>,
): Promise<(string | null)[]> {
  for (const ref of refs) {
    if (ref.id == null || ref.name?.trim()) continue
    const id = String(ref.id)
    if (!cache.has(id)) {
      try { cache.set(id, await lookup(id, ref.taskKey)) }
      catch { cache.set(id, null) }
    }
  }
  return refs.map((ref) => {
    const direct = ref.name?.trim()
    if (direct) return direct
    return ref.id == null ? null : cache.get(String(ref.id)) ?? null
  })
}

const uncachedAssignees: AssigneeResolver = (_namespace, refs, lookup) =>
  resolveAssigneeIds(refs, new Map(), lookup)

function workspaceSource(
  project: string, env: string, openStatuses: string[], states: TrackerSettings['states'],
  lookup: NonNullable<TrackerSettings['assigneeLookup']>, resolveAssignees: AssigneeResolver,
): TrackerSource {
  const assignees = (m: ToolCaller, refs: AssigneeRef[]) =>
    resolveAssignees(project, refs, async (id, taskKey) => {
      if (lookup === 'task-detail' && taskKey) {
        const detail = await m.callTool('get-task-tool', { id: taskKey }) as
          { assignee?: string | null; assignee_id?: string | number | null }
        return String(detail.assignee_id) === id ? detail.assignee?.trim() || null : null
      }
      const person = await m.callTool('person-lookup-tool', { id }) as { name?: string | null }
      return person.name?.trim() || null
    })
  return {
    project, env,
    async fetch(m) {
      const out: TrackerTask[] = []
      const refs: AssigneeRef[] = []
      for (const status of openStatuses) {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const r = await m.callTool('list-tasks-tool', { status, page, per_page: 100 }) as {
            tasks?: { short_id?: string; summary?: string; status?: string
                      status_category?: string; assignee_id?: string | number | null }[]
            last_page?: number
          }
          for (const t of r.tasks ?? []) {
            if (!t.short_id) continue
            out.push({
              key: t.short_id.toUpperCase(), project, title: decode(t.summary ?? ''),
              status: t.status ?? status,
              category: categoryOf(t.status ?? '', t.status_category ?? status, states),
              updatedAt: null, assignee: null,
            })
            refs.push({ id: t.assignee_id, taskKey: t.short_id.toUpperCase() })
          }
          if (!r.last_page || page >= r.last_page) break
        }
      }
      const names = await assignees(m, refs)
      out.forEach((task, index) => { task.assignee = names[index] ?? null })
      return out
    },
    async lookup(m, key) {
      const r = await m.callTool('list-tasks-tool', { search: key, per_page: 5 }) as {
        tasks?: { short_id?: string; summary?: string; status?: string
                  status_category?: string; assignee_id?: string | number | null }[]
      }
      const hit = (r.tasks ?? []).find((t) => t.short_id?.toUpperCase() === key)
      if (!hit) return null
      const [assignee] = await assignees(m, [{ id: hit.assignee_id, taskKey: key }])
      return {
        key, project, title: decode(hit.summary ?? ''), status: hit.status ?? '',
        category: categoryOf(hit.status ?? '', hit.status_category ?? 'completed', states),
        updatedAt: null, assignee: assignee ?? null,
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
  project: string, env: string, openStatuses: string[], states: TrackerSettings['states'],
): TrackerSource {
  return {
    project, env,
    async fetch(m) {
      const out: TrackerTask[] = []
      for (const status of openStatuses) {
        let cursor: string | undefined
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await m.callTool('task.list', {
            status, limit: 100, ...(cursor ? { cursor } : {}),
          }) as { data?: { items?: { humanKey?: string; title?: string; status?: string
                                     updatedAt?: string; assigneeName?: string | null }[]
                          nextCursor?: string } }
          for (const t of r.data?.items ?? []) {
            if (!t.humanKey) continue
            out.push({
              key: t.humanKey.toUpperCase(), project, title: decode(t.title ?? ''),
              status: t.status ?? status,
              category: categoryOf(t.status ?? '', t.status ?? status, states),
              updatedAt: t.updatedAt ?? null, assignee: t.assigneeName?.trim() || null,
            })
          }
          cursor = r.data?.nextCursor
          if (!cursor) break
        }
      }
      return out
    },
    async lookup(m, key) {
      const r = await m.callTool('task.getByKey', { taskKey: key }) as {
        data?: { humanKey?: string; title?: string; status?: string; updatedAt?: string
                 assigneeName?: string | null }
      }
      const t = r.data
      if (!t?.humanKey) return null
      return {
        key, project, title: decode(t.title ?? ''), status: t.status ?? '',
        category: categoryOf(t.status ?? '', t.status ?? 'done', states),
        updatedAt: t.updatedAt ?? null, assignee: t.assigneeName?.trim() || null,
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
  project: string, env: string, openStatuses: string[], states: TrackerSettings['states'],
): TrackerSource {
  return {
    project, env,
    async fetch(m) {
      const out: TrackerTask[] = []
      for (const status of openStatuses) {
        const r = await m.callTool('task_list', { status }) as
          { key?: string; title?: string; status?: string; assigneeName?: string | null }[]
        for (const t of Array.isArray(r) ? r : []) {
          if (!t.key) continue
          out.push({
            key: t.key.toUpperCase(), project, title: decode(t.title ?? ''),
            status: t.status ?? status,
            category: categoryOf(t.status ?? '', t.status ?? status, states),
            updatedAt: null, assignee: t.assigneeName?.trim() || null,
          })
        }
      }
      return out
    },
    async lookup(m, key) {
      const r = await m.callTool('task_list', { search: key }) as
        { key?: string; title?: string; status?: string; updatedAt?: string
          assigneeName?: string | null }[]
      const hit = (Array.isArray(r) ? r : []).find((t) => t.key?.toUpperCase() === key)
      if (!hit) return null
      return {
        key, project, title: decode(hit.title ?? ''), status: hit.status ?? '',
        category: categoryOf(hit.status ?? '', hit.status ?? 'done', states),
        updatedAt: hit.updatedAt ?? null, assignee: hit.assigneeName?.trim() || null,
      }
    },
  }
}

export function trackerSourceFor(
  project: TrackerProject, resolveAssignees: AssigneeResolver = uncachedAssignees,
): TrackerSource | null {
  const tracker = project.settings.tracker
  if (!tracker) return null
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
      project.name, env, statuses, tracker.states,
      tracker.assigneeLookup ?? 'person-lookup', resolveAssignees,
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

/** Create through a caller whose connection and lifetime remain owned by the caller. */
export async function createTrackerTask(
  m: ToolCaller, project: TrackerProject, task: CreateTrackerTask,
): Promise<unknown> {
  const tracker = project.settings.tracker
  if (!tracker) throw new Error(`project ${project.name} has no tracker configured`)
  assertKnownStatus(project, task.status)

  if (tracker.protocol === 'workspace-mcp') {
    // The two readable workspace-mcp schemas disagree: one accepts `status`,
    // while the other accepts `task_status_id`. Sending either for the protocol
    // as a whole would guess which server is behind the connection.
    throw new Error(WORKSPACE_CREATE_REFUSAL)
  }
  if (tracker.protocol === 'cursor-mcp') {
    // Its tool schema requires projectId; the register carries no tracker field
    // from which that UUID can be obtained.
    throw new Error(CURSOR_CREATE_REFUSAL)
  }
  if (tracker.protocol === 'array-mcp') {
    // The reflected task.create schema establishes these names; the MCP bridge
    // exposes its dotted procedure name on the wire with an underscore.
    return m.callTool('task_create', {
      title: task.title,
      description: task.body,
      status: task.status,
    })
  }
  throw new Error(`tracker protocol ${tracker.protocol ?? '(missing)'} has no create support`)
}
