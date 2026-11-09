import { z } from 'zod'

import { PLATFORM_SLUG } from './brand.ts'
import {
  TRACKER_ACTIONS,
  type TrackerAction,
  type TrackerProtocol,
  trackerWireAction,
} from './tracker-actions.ts'
import { scopedRows, type ToolCaller, toolDeclaresInput } from './tracker-list-scope.ts'
import {
  arrayStatusPayload,
  cursorStatusPayload,
  workspaceStatusPayload,
} from './tracker-status-payload.ts'
import {
  arrayTaskForKey,
  cursorTaskNotFound,
  readArrayTaskText,
  readCursorTaskText,
  readWorkspaceTaskText,
  TrackerLookupUnverifiable,
  type TrackerTaskText,
} from './tracker-task-text.ts'

export type StatusCategory = 'open' | 'active' | 'review' | 'done' | 'dropped'
export const TASK_STATUSES = ['open', 'active', 'review', 'done', 'dropped'] as const
const UPDATED_SINCE_PROTOCOLS: ReadonlySet<TrackerProtocol> = new Set([
  'workspace-mcp',
  'cursor-mcp',
])
const updatedSinceProtocolList = [...UPDATED_SINCE_PROTOCOLS].join(' and ')
export const ARRAY_MCP_STATUS_WRITE_CONFIRM = 'production'

// A tracker kind and its state names are written into workflow steps an agent
// follows, so they are plain names with no shell syntax.
const trackerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, 'must be a plain name: letters, digits, space, _ . -')

export const trackerActionsShape = Object.fromEntries(
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

export const trackerReviewStagesShape = {
  waiting: trackerNameSchema,
  active: trackerNameSchema,
}

export const trackerWriteStatesShape = {
  open: trackerNameSchema.optional(),
  active: trackerNameSchema.optional(),
  review: trackerNameSchema.optional(),
  done: trackerNameSchema.optional(),
  dropped: trackerNameSchema.optional(),
}

// The inner objects are strict here; a consumer that must accept a newer
// key rebuilds them over these shapes.
export const trackerSettingsShape = {
  kind: trackerNameSchema.optional(),
  protocol: z.string().trim().min(1).optional(),
  team: z.string().trim().min(1).optional(),
  projectId: z.string().uuid().optional(),
  assigneeLookup: z.enum(['person-lookup', 'task-detail']).optional(),
  envPrefix: z.string().trim().min(1).optional(),
  openStatuses: z.array(z.string()).optional(),
  updatedSince: z.boolean().optional(),
  completesOnMerge: z.boolean().optional(),
  states: z.record(trackerNameSchema, z.enum(['backlog', ...TASK_STATUSES])).optional(),
  reviewStages: z.strictObject(trackerReviewStagesShape).optional(),
  writeStates: z.strictObject(trackerWriteStatesShape).optional(),
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
      message: 'the built-in tracker accepts no action overrides; remove tracker.actions',
    })
  }
}

/** The cursor project id is accepted only by the adapter that owns it. */
export function refuseNonCursorProjectId(
  tracker: TrackerSettings,
  context: z.core.$RefinementCtx<TrackerSettings>,
): void {
  if (tracker.projectId !== undefined && tracker.protocol !== 'cursor-mcp') {
    context.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'projectId is accepted only by the cursor-mcp protocol; remove tracker.projectId',
    })
  }
}

/** Only protocols with a defined incremental request may declare it. */
export function refuseUnsupportedUpdatedSince(
  tracker: TrackerSettings,
  context: z.core.$RefinementCtx<TrackerSettings>,
): void {
  if (
    tracker.updatedSince !== undefined &&
    !UPDATED_SINCE_PROTOCOLS.has(tracker.protocol as TrackerProtocol)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['updatedSince'],
      message: `updatedSince is accepted only by the ${updatedSinceProtocolList} protocols; remove tracker.updatedSince`,
    })
  }
}

/** Review stage names select two distinct raw states already categorized as review. */
export function refuseInvalidReviewStages(
  tracker: TrackerSettings,
  context: z.core.$RefinementCtx<TrackerSettings>,
): void {
  const stages = tracker.reviewStages
  if (!stages) return
  const remedy =
    `set it with: ${PLATFORM_SLUG} project set <name> --settings ` +
    `'${JSON.stringify({ tracker: { reviewStages: { waiting: '<waiting-review-state>', active: '<in-review-state>' } } })}'`
  for (const [stage, raw] of Object.entries(stages)) {
    const category = tracker.states?.[raw]
    if (category !== 'review') {
      context.addIssue({
        code: 'custom',
        path: ['reviewStages', stage],
        message:
          category === undefined
            ? `value "${raw}" is not a key of tracker.states; ${remedy}`
            : `value "${raw}" maps to "${category}", not "review"; ${remedy}`,
      })
    }
  }
  if (stages.waiting === stages.active) {
    context.addIssue({
      code: 'custom',
      path: ['reviewStages', 'active'],
      message: `value "${stages.active}" must differ from reviewStages.waiting; ${remedy}`,
    })
  }
}

/** Write state names select raw states already categorized for their transition. */
export function refuseInvalidWriteStates(
  tracker: TrackerSettings,
  context: z.core.$RefinementCtx<TrackerSettings>,
): void {
  const writeStates = tracker.writeStates
  if (!writeStates) return
  for (const [category, raw] of Object.entries(writeStates)) {
    const writeStateRemedy =
      `set it with: ${PLATFORM_SLUG} project set <name> --settings ` +
      `'${JSON.stringify({ tracker: { writeStates: { [category]: `<${category}-state>` } } })}'`
    const mapped = tracker.states?.[raw]
    if (!trackerStateMayWriteCategory(mapped, category as StatusCategory)) {
      const absentStateRemedy =
        `set it with: ${PLATFORM_SLUG} project set <name> --settings ` +
        `'${JSON.stringify({ tracker: { states: { [raw]: category }, writeStates: { [category]: raw } } })}'`
      context.addIssue({
        code: 'custom',
        path: ['writeStates', category],
        message:
          mapped === undefined
            ? `value "${raw}" is not a key of tracker.states; ${absentStateRemedy}`
            : `value "${raw}" maps to "${mapped}", not "${category}"; ${writeStateRemedy}`,
      })
    }
  }
}

/** Whether a raw state mapping is writable for a requested category. */
function trackerStateMayWriteCategory(
  mapped: string | undefined,
  category: StatusCategory,
): boolean {
  return mapped === category || (category === 'open' && mapped === 'backlog')
}

/** Map a category word or registered raw state to the writable task category. */
export function trackerWriteCategory(
  tracker: TrackerSettings,
  requested: string,
): StatusCategory | undefined {
  if (TASK_STATUSES.includes(requested as StatusCategory)) return requested as StatusCategory
  const mapped = tracker.states?.[requested]
  return mapped === 'backlog' ? 'open' : mapped
}

/** Select the raw state accepted by a tracker for a writable task category. */
export function resolveTrackerWriteState(
  projectName: string,
  tracker: TrackerSettings,
  protocol: TrackerProtocol,
  category: StatusCategory,
): string | undefined {
  const rawStates = Object.entries(tracker.states ?? {}).flatMap(([raw, mapped]) =>
    trackerStateMayWriteCategory(mapped, category) ? [raw] : [],
  )
  const selected = tracker.writeStates?.[category]
  if (!selected && rawStates.length > 1) {
    throw new Error(
      `project ${projectName} tracker has several ${category} states (${rawStates.join(', ')}) but no writeStates.${category} selection; set it with: ${PLATFORM_SLUG} project set ${projectName} --settings '${JSON.stringify({ tracker: { writeStates: { [category]: `<${category}-state>` } } })}'`,
    )
  }
  if (protocol === 'workspace-mcp' && !selected) {
    throw new Error(
      `project ${projectName} tracker has no writeStates.${category} selection; set it with: ${PLATFORM_SLUG} project set ${projectName} --settings '${JSON.stringify({ tracker: { writeStates: { [category]: `<${category}-state>` } } })}'`,
    )
  }
  return selected ?? rawStates[0] ?? (protocol === 'hub' ? category : undefined)
}

export type TrackerProject = {
  name: string
  settings: {
    envPrefix?: string
    tracker?: TrackerSettings
    [key: string]: unknown
  }
}

export function trackerEnvPrefix(project: TrackerProject): string {
  const env = project.settings.tracker?.envPrefix ?? project.settings.envPrefix
  if (!env) throw new Error(`project ${project.name} tracker is missing envPrefix`)
  return env
}

export const CURSOR_CREATE_REFUSAL =
  'cursor-mcp create refused: required projectId has no value in the tracker register'
export const workspaceScopeRefusal = (verb: 'create' | 'collect', project: string): string =>
  `workspace-mcp ${verb} refused: project ${project} tracker is missing team; ` +
  `set it with: ${PLATFORM_SLUG} project set ${project} --settings '{"tracker":{"team":"…"}}'`
export const cursorScopeRefusal = (verb: 'create' | 'collect', project: string): string =>
  `${verb === 'create' ? CURSOR_CREATE_REFUSAL : `cursor-mcp collect refused: project ${project} tracker is missing projectId`}; set it with: ${PLATFORM_SLUG} project set ${project} --settings ` +
  `'${JSON.stringify({ tracker: { projectId: '…' } })}'`

export type TrackerTask = {
  externalId: string | null
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
  /** The register declares that this source accepts its protocol's updated-since filter. */
  supportsUpdatedSince: boolean
  fetch: (m: ToolCaller, updatedSince?: string) => Promise<TrackerFetchResult>
  /** Present only when this protocol has a status-write payload proven against its live server. */
  writeStatus?: (
    m: ToolCaller,
    task: Pick<TrackerTask, 'externalId' | 'key'>,
    status: string,
    category: StatusCategory,
    confirm: string,
  ) => Promise<TrackerStatusWriteResult>
  /** One closed task by key, for work the window touched but the sync skipped. */
  lookup?: (m: ToolCaller, key: string) => Promise<TrackerTask | null>
  /**
   * The comment ids one task's read reports, or null when that read answers
   * without them. The member exists only for a protocol whose single-task read
   * carries comments, so a caller can tell a task with no comments from a read
   * that cannot report any.
   */
  readCommentIds?: (m: ToolCaller, key: string) => Promise<string[] | null>
  readText?: (m: ToolCaller, key: string) => Promise<TrackerTaskText | null>
}

type TrackerStatusWriteResult = {
  status: string
  category: StatusCategory
  /** A refusal that must be raised after the returned observation is recorded. */
  refusal?: string
}

export type TrackerFetchResult = {
  tasks: TrackerTask[]
  complete: boolean
  deletedKeys: string[]
}

/**
 * Open work is fetched in full; closed work is looked up by key only when a
 * caller needs it. Enough pages to hold any project's open work, with a stop so
 * nothing spins.
 */
export const MAX_PAGES = 40
export const WORKSPACE_LOOKUP_PAGE_SIZE = 5
const WORKSPACE_LOOKUP_MAX_PAGES = MAX_PAGES

/** The raw status word wins where it is finer than the tracker's category. */
/** The category a status establishes, or null when neither the word nor the project's states name one. */
function establishedCategory(
  rawStatus: string,
  category: string,
  states: TrackerSettings['states'],
): StatusCategory | null {
  const w = rawStatus.toLowerCase()
  if (/review/.test(w)) return 'review'
  if (/blocked|on hold/.test(w)) return 'review'
  const normal = (value: string) => value.toLowerCase().replace(/[ -]+/g, '_')
  const mapped =
    states?.[rawStatus] ??
    states?.[normal(rawStatus)] ??
    states?.[category] ??
    states?.[normal(category)]
  return mapped === 'backlog' ? 'open' : (mapped ?? null)
}

export function categoryForTrackerRead(
  incremental: boolean,
  rawStatus: string | undefined,
  categoryHint: string | undefined,
  fullReadFallbackHint: string | undefined,
  states: TrackerSettings['states'],
): StatusCategory | null {
  if (incremental) {
    return rawStatus ? establishedCategory(rawStatus, categoryHint ?? '', states) : null
  }
  return fullReadCategory(rawStatus, categoryHint, fullReadFallbackHint, states)
}

/** A full read lists open work by status, so a row whose status maps nowhere is open. */
function fullReadCategory(
  rawStatus: string | undefined,
  categoryHint: string | undefined,
  fallbackHint: string | undefined,
  states: TrackerSettings['states'],
): StatusCategory {
  return categoryOf(rawStatus ?? '', categoryHint ?? fallbackHint ?? '', states)
}

function categoryOf(
  rawStatus: string,
  category: string,
  states: TrackerSettings['states'],
): StatusCategory {
  return establishedCategory(rawStatus, category, states) ?? 'open'
}

async function readTrackerPages(
  readPage: (pageIndex: number) => Promise<boolean>,
): Promise<{ complete: boolean }> {
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    if (!(await readPage(pageIndex))) return { complete: true }
  }
  return { complete: false }
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

/** Whether a tracker reply entry names a comment: a non-empty string or an integer. */
export const isTrackerCommentId = (id: unknown): id is string | number =>
  typeof id === 'string' ? id.length > 0 : Number.isInteger(id)

/** The ids a tracker task read reports, or null when that read carries no comments. */
const trackerTaskCommentIds = (reply: unknown): string[] | null => {
  const comments = (reply as { comments?: { id?: string | number }[] } | null)?.comments
  if (!Array.isArray(comments)) return null
  return comments
    .map((comment) => comment?.id)
    .filter(isTrackerCommentId)
    .map(String)
}

/** One workspace task's assignees, resolved through the register's lookup setting. */
function workspaceAssignees(
  project: string,
  getAction: string,
  lookup: NonNullable<TrackerSettings['assigneeLookup']>,
  resolveAssignees: AssigneeResolver,
): (m: ToolCaller, refs: AssigneeRef[]) => Promise<(string | null)[]> {
  return (m, refs) =>
    resolveAssignees(project, refs, async (id, taskKey) => {
      if (lookup === 'task-detail' && taskKey) {
        const detail = (await m.callTool(getAction, {
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
}

type WorkspaceTask = {
  id?: string
  short_id?: string
  summary?: string
  status?: string
  status_category?: string
  assignee_id?: string | number | null
  updated_at?: string
  team?: string
}

type WorkspaceTaskDetail = Omit<WorkspaceTask, 'status'> & {
  status?: string | { name?: unknown }
}

type WorkspaceAssignees = (m: ToolCaller, refs: AssigneeRef[]) => Promise<(string | null)[]>

async function mappedWorkspaceTask(
  m: ToolCaller,
  key: string,
  project: string,
  states: TrackerSettings['states'],
  assignees: WorkspaceAssignees,
  hit: WorkspaceTask,
): Promise<TrackerTask> {
  const [assignee] = await assignees(m, [{ id: hit.assignee_id, taskKey: key }])
  return {
    externalId: hit.id ?? null,
    key,
    project,
    title: decode(hit.summary ?? ''),
    status: hit.status ?? '',
    category: categoryOf(hit.status ?? '', hit.status_category ?? 'completed', states),
    updatedAt: null,
    assignee: assignee ?? null,
  }
}

function normalizeWorkspaceTaskDetail(detail: WorkspaceTaskDetail): WorkspaceTask | null {
  if (typeof detail.status === 'string') return { ...detail, status: detail.status }
  if (
    detail.status &&
    typeof detail.status === 'object' &&
    typeof detail.status.name === 'string'
  ) {
    return { ...detail, status: detail.status.name }
  }
  return null
}

async function lookupWorkspaceTask(
  m: ToolCaller,
  key: string,
  project: string,
  states: TrackerSettings['states'],
  assignees: WorkspaceAssignees,
  getAction: string,
  searchAction: string,
): Promise<TrackerTask | null> {
  const normalizedKey = key.toUpperCase()
  try {
    const detail = await m.callTool(getAction, { id: key })
    if (detail && typeof detail === 'object') {
      const task = normalizeWorkspaceTaskDetail(detail as WorkspaceTaskDetail)
      if (task?.short_id?.toUpperCase() === normalizedKey) {
        return mappedWorkspaceTask(m, key, project, states, assignees, task)
      }
    }
  } catch {
    // The protocol has no structured not-found response, so search establishes absence.
  }

  for (let page = 1; page <= WORKSPACE_LOOKUP_MAX_PAGES; page++) {
    const r = await m.callTool(searchAction, {
      search: key,
      page,
      per_page: WORKSPACE_LOOKUP_PAGE_SIZE,
    })
    if (!r || typeof r !== 'object' || !Array.isArray((r as { tasks?: unknown }).tasks)) {
      throw new TrackerLookupUnverifiable(
        'workspace-mcp',
        key,
        'lookup for {key} returned an unexpected response',
      )
    }
    const pageResult = r as { tasks: WorkspaceTask[]; last_page?: number }
    const hit = pageResult.tasks.find((task) => task.short_id?.toUpperCase() === normalizedKey)
    if (hit) return mappedWorkspaceTask(m, key, project, states, assignees, hit)
    if (!pageResult.last_page || page >= pageResult.last_page) return null
    if (page === WORKSPACE_LOOKUP_MAX_PAGES) {
      throw new TrackerLookupUnverifiable(
        'workspace-mcp',
        key,
        `lookup for {key} reached the paging bound of ${WORKSPACE_LOOKUP_MAX_PAGES} before the last page`,
      )
    }
  }

  throw new TrackerLookupUnverifiable(
    'workspace-mcp',
    key,
    `lookup for {key} reached the paging bound of ${WORKSPACE_LOOKUP_MAX_PAGES} before the last page`,
  )
}

function appendWorkspaceTasks(
  tasks: TrackerTask[],
  refs: AssigneeRef[],
  rows: WorkspaceTask[],
  project: string,
  status: string | undefined,
  updatedSince: string | undefined,
  states: TrackerSettings['states'],
): boolean {
  let complete = true
  for (const task of rows) {
    if (!task.short_id) continue
    // An incremental read also returns closed rows, so a status that establishes no category
    // cannot default to open; the read is partial and the next one is full.
    const category = categoryForTrackerRead(
      updatedSince !== undefined,
      task.status,
      task.status_category,
      status,
      states,
    )
    if (category === null) {
      complete = false
      continue
    }
    const key = task.short_id.toUpperCase()
    tasks.push({
      externalId: task.id ?? null,
      key,
      project,
      title: decode(task.summary ?? ''),
      status: task.status ?? status ?? '',
      category,
      updatedAt: updatedSince === undefined ? null : (task.updated_at ?? null),
      assignee: null,
    })
    refs.push({ id: task.assignee_id, taskKey: key })
  }
  return complete
}

async function fetchWorkspaceStatus(
  m: ToolCaller,
  project: string,
  status: string | undefined,
  updatedSince: string | undefined,
  states: TrackerSettings['states'],
  searchAction: string,
  team: string,
  sendsScope: boolean,
): Promise<{ tasks: TrackerTask[]; refs: AssigneeRef[]; complete: boolean }> {
  const tasks: TrackerTask[] = []
  const refs: AssigneeRef[] = []
  let complete = true
  const pages = await readTrackerPages(async (pageIndex) => {
    const page = pageIndex + 1
    const reply = (await m.callTool(searchAction, {
      ...(updatedSince === undefined ? { status } : { updated_since: updatedSince }),
      ...(sendsScope ? { team_id: team } : {}),
      page,
      per_page: 100,
    })) as { tasks?: WorkspaceTask[]; last_page?: number }
    const rows = sendsScope
      ? (reply.tasks ?? [])
      : scopedRows(
          (reply.tasks ?? []) as (WorkspaceTask & Record<string, unknown>)[],
          'team',
          team,
          `workspace-mcp collect refused for project ${project}: search schema has no team_id and returned rows carry no team scope`,
        )
    complete &&= appendWorkspaceTasks(tasks, refs, rows, project, status, updatedSince, states)
    return Boolean(reply.last_page && page < reply.last_page)
  })
  complete &&= pages.complete
  return { tasks, refs, complete }
}

function workspaceSource(
  project: string,
  env: string,
  supportsUpdatedSince: boolean,
  openStatuses: string[],
  states: TrackerSettings['states'],
  team: string | undefined,
  actions: TrackerSettings['actions'],
  lookup: NonNullable<TrackerSettings['assigneeLookup']>,
  resolveAssignees: AssigneeResolver,
): TrackerSource {
  const searchAction = actions?.search ?? trackerWireAction('workspace-mcp', 'search')
  const getAction = actions?.get ?? trackerWireAction('workspace-mcp', 'get')
  const statusAction = actions?.status ?? trackerWireAction('workspace-mcp', 'status')
  const assignees = workspaceAssignees(project, getAction, lookup, resolveAssignees)
  return {
    project,
    env,
    supportsUpdatedSince,
    async fetch(m, updatedSince) {
      if (!team) {
        throw new Error(workspaceScopeRefusal('collect', project))
      }
      const sendsScope = await toolDeclaresInput(m, searchAction, 'team_id')
      const out: TrackerTask[] = []
      const refs: AssigneeRef[] = []
      let complete = true
      for (const status of updatedSince === undefined ? openStatuses : [undefined]) {
        const fetched = await fetchWorkspaceStatus(
          m,
          project,
          status,
          updatedSince,
          states,
          searchAction,
          team,
          sendsScope,
        )
        out.push(...fetched.tasks)
        refs.push(...fetched.refs)
        complete &&= fetched.complete
      }
      const names = await assignees(m, refs)
      out.forEach((task, index) => {
        task.assignee = names[index] ?? null
      })
      return { tasks: out, complete, deletedKeys: [] }
    },
    async writeStatus(m, task, status, category) {
      await m.callTool(statusAction, workspaceStatusPayload(statusAction, task.key, status))
      const detail = (await m.callTool(getAction, { id: task.key })) as WorkspaceTaskDetail
      const normalized = normalizeWorkspaceTaskDetail(detail)
      if (!normalized?.status?.trim()) {
        throw new Error(
          `workspace-mcp status confirmation for task ${task.key} returned no status after category ${category} was requested`,
        )
      }
      const confirmedCategory = categoryOf(
        normalized.status,
        normalized.status_category ?? '',
        states,
      )
      return {
        status: normalized.status,
        category: confirmedCategory,
        ...(confirmedCategory === category
          ? {}
          : {
              refusal: `workspace-mcp status confirmation for task ${task.key} returned category ${confirmedCategory} after category ${category} was requested`,
            }),
      }
    },
    async lookup(m, key) {
      return lookupWorkspaceTask(m, key, project, states, assignees, getAction, searchAction)
    },
    readText: (m, key) => readWorkspaceTaskText(m, key, getAction),
    // The search page a lookup reads carries no comments; the descriptor's get
    // tool answers one task with its `comments[].id`.
    async readCommentIds(m, key) {
      return trackerTaskCommentIds(await m.callTool(getAction, { id: key }))
    },
  }
}

type CursorTask = {
  id?: string
  humanKey?: string
  title?: string
  status?: string
  updatedAt?: string
  assigneeName?: string | null
  deletedAt?: string | null
  projectId?: string
}

function appendCursorTasks(
  out: TrackerTask[],
  items: CursorTask[],
  project: string,
  status: string | undefined,
  incremental: boolean,
  states: TrackerSettings['states'],
): { deletedKeys: string[]; complete: boolean } {
  const deletedKeys: string[] = []
  let complete = true
  for (const task of items) {
    if (task.deletedAt) {
      if (task.humanKey) deletedKeys.push(task.humanKey.toUpperCase())
      continue
    }
    if (!task.humanKey) continue
    const category = categoryForTrackerRead(incremental, task.status, task.status, status, states)
    if (category === null) {
      complete = false
      continue
    }
    out.push({
      externalId: task.id ?? null,
      key: task.humanKey.toUpperCase(),
      project,
      title: decode(task.title ?? ''),
      status: task.status ?? status ?? '',
      category,
      updatedAt: task.updatedAt ?? null,
      assignee: task.assigneeName?.trim() || null,
    })
  }
  return { deletedKeys, complete }
}

async function lookupCursorTask(
  m: ToolCaller,
  key: string,
  project: string,
  states: TrackerSettings['states'],
  getAction: string,
): Promise<TrackerTask | null> {
  let response: unknown
  try {
    response = await m.callTool(getAction, { taskKey: key })
  } catch (cause) {
    if (cursorTaskNotFound(cause)) return null
    throw cause
  }
  const r = response as {
    success?: boolean
    data?: CursorTask
  }
  const task = r.data
  if (r.success !== true || !task?.humanKey) {
    throw new TrackerLookupUnverifiable(
      'cursor-mcp',
      key,
      'lookup for {key} returned an unexpected response',
    )
  }
  return {
    externalId: task.id ?? null,
    key,
    project,
    title: decode(task.title ?? ''),
    status: task.status ?? '',
    category: categoryOf(task.status ?? '', task.status ?? 'done', states),
    updatedAt: task.updatedAt ?? null,
    assignee: task.assigneeName?.trim() || null,
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
  supportsUpdatedSince: boolean,
  openStatuses: string[],
  states: TrackerSettings['states'],
  projectId: string | undefined,
  actions: TrackerSettings['actions'],
): TrackerSource {
  const searchAction = actions?.search ?? trackerWireAction('cursor-mcp', 'search')
  const getAction = actions?.get ?? trackerWireAction('cursor-mcp', 'get')
  const statusAction = actions?.status ?? trackerWireAction('cursor-mcp', 'status')
  const listCommentsAction =
    actions?.['list-comments'] ?? trackerWireAction('cursor-mcp', 'list-comments')
  return {
    project,
    env,
    supportsUpdatedSince,
    async fetch(m, updatedSince) {
      if (!projectId) {
        throw new Error(cursorScopeRefusal('collect', project))
      }
      const sendsScope = await toolDeclaresInput(m, searchAction, 'projectId')
      const out: TrackerTask[] = []
      let complete = true
      const deletedKeys: string[] = []
      for (const status of updatedSince === undefined ? openStatuses : [undefined]) {
        let cursor: string | undefined
        const pages = await readTrackerPages(async () => {
          const r = (await m.callTool(searchAction, {
            ...(updatedSince === undefined ? { status } : { updatedSince }),
            ...(sendsScope ? { projectId } : {}),
            limit: 100,
            ...(cursor ? { cursor } : {}),
          })) as {
            data?: {
              items?: CursorTask[]
              nextCursor?: string
            }
          }
          const rows = sendsScope
            ? (r.data?.items ?? [])
            : scopedRows(
                (r.data?.items ?? []) as (CursorTask & Record<string, unknown>)[],
                'projectId',
                projectId,
                `cursor-mcp collect refused for project ${project}: search schema has no projectId and returned rows carry no projectId scope`,
              )
          const appended = appendCursorTasks(
            out,
            rows,
            project,
            status,
            updatedSince !== undefined,
            states,
          )
          deletedKeys.push(...appended.deletedKeys)
          complete &&= appended.complete
          cursor = r.data?.nextCursor
          return Boolean(cursor)
        })
        complete &&= pages.complete
      }
      return { tasks: out, complete, deletedKeys }
    },
    async writeStatus(m, task, status, _category) {
      if (!task.externalId) {
        throw new Error(`cursor-mcp status write refused: task ${task.key} has no external id`)
      }
      const reply = (await m.callTool(
        statusAction,
        cursorStatusPayload(task.externalId, status),
      )) as { success?: unknown; data?: { status?: unknown }; error?: unknown }
      const confirmed = reply.data?.status
      if (reply.success !== true || typeof confirmed !== 'string' || !confirmed.trim()) {
        throw new Error(
          `cursor-mcp status confirmation for task ${task.key} returned ${JSON.stringify(reply)} after ${status} was requested`,
        )
      }
      const observedStatus = confirmed
      const observedCategory = categoryOf(observedStatus, observedStatus, states)
      return {
        status: observedStatus,
        category: observedCategory,
        ...(observedStatus === status
          ? {}
          : {
              refusal: `cursor-mcp status confirmation for task ${task.key} returned ${observedStatus} after ${status} was requested`,
            }),
      }
    },
    async lookup(m, key) {
      return lookupCursorTask(m, key, project, states, getAction)
    },
    readText: (m, key) => readCursorTaskText(m, key, getAction, listCommentsAction),
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
  actions: TrackerSettings['actions'],
): TrackerSource {
  const searchAction = actions?.search ?? trackerWireAction('array-mcp', 'search')
  const getAction = actions?.get ?? trackerWireAction('array-mcp', 'get')
  const statusAction = actions?.status ?? trackerWireAction('array-mcp', 'status')
  return {
    project,
    env,
    supportsUpdatedSince: false,
    async fetch(m) {
      const out: TrackerTask[] = []
      for (const status of openStatuses) {
        const r = (await m.callTool(searchAction, { status })) as {
          id?: string
          key?: string
          title?: string
          status?: string
          assigneeName?: string | null
        }[]
        for (const t of Array.isArray(r) ? r : []) {
          if (!t.key) continue
          out.push({
            externalId: t.id ?? null,
            key: t.key.toUpperCase(),
            project,
            title: decode(t.title ?? ''),
            status: t.status ?? status,
            category: fullReadCategory(t.status, t.status, status, states),
            updatedAt: null,
            assignee: t.assigneeName?.trim() || null,
          })
        }
      }
      return { tasks: out, complete: true, deletedKeys: [] }
    },
    async writeStatus(m, task, status, category, confirm) {
      if (!task.externalId) throw new Error(`task in project ${project} has no external id`)
      const reply = (await m.callTool(
        statusAction,
        arrayStatusPayload(task.externalId, status, confirm),
      )) as { status?: unknown }
      const confirmed =
        typeof reply?.status === 'string' && reply.status.trim() ? reply.status : null
      const observedStatus = confirmed ?? status
      return {
        status: observedStatus,
        category: confirmed ? categoryOf(confirmed, confirmed, states) : category,
        ...(observedStatus === status
          ? {}
          : {
              refusal: `tracker answered with status ${observedStatus} after ${status} was requested for task ${task.key}`,
            }),
      }
    },
    async lookup(m, key) {
      const r = await m.callTool(getAction, { search: key })
      if (!Array.isArray(r)) {
        throw new TrackerLookupUnverifiable(
          'array-mcp',
          key,
          'lookup for {key} returned an unexpected response',
        )
      }
      const rows = r as {
        id?: string
        key?: string
        title?: string
        status?: string
        updatedAt?: string
        assigneeName?: string | null
      }[]
      const hit = arrayTaskForKey(rows, key)
      if (!hit) return null
      return {
        externalId: hit.id ?? null,
        key,
        project,
        title: decode(hit.title ?? ''),
        status: hit.status ?? '',
        category: categoryOf(hit.status ?? '', hit.status ?? 'done', states),
        updatedAt: hit.updatedAt ?? null,
        assignee: hit.assigneeName?.trim() || null,
      }
    },
    readText: (m, key) => readArrayTaskText(m, key, getAction),
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
      `project ${project.name} tracker has unrecognized protocol ${tracker.protocol ?? '(missing)'}`,
    )
  }
  const env = trackerEnvPrefix(project)
  const statuses = tracker.openStatuses ?? []
  if (tracker.protocol === 'workspace-mcp') {
    return workspaceSource(
      project.name,
      env,
      tracker.updatedSince === true,
      statuses,
      tracker.states,
      tracker.team,
      tracker.actions,
      tracker.assigneeLookup ?? 'person-lookup',
      resolveAssignees,
    )
  }
  if (tracker.protocol === 'cursor-mcp') {
    return cursorMcpSource(
      project.name,
      env,
      tracker.updatedSince === true,
      statuses,
      tracker.states,
      tracker.projectId,
      tracker.actions,
    )
  }
  if (tracker.protocol === 'array-mcp') {
    return arrayMcpSource(project.name, env, statuses, tracker.states, tracker.actions)
  }
  // Exhaustive above; kept explicit so a future protocol cannot silently build nothing.
  throw new Error(`project ${project.name} tracker has unrecognized protocol ${tracker.protocol}`)
}
