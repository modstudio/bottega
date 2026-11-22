import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { ToolCaller } from '../../../shared/tracker-list-scope.ts'
import { TrackerLookupUnverifiable } from '../../../shared/tracker-task-text.ts'
import {
  type AssigneeRef,
  resolveAssigneeIds,
  type TrackerFetchResult,
  type TrackerSource,
  type TrackerTask,
  trackerSourceFor,
} from '../../../shared/trackers.ts'
import { db, nowIso, type Project, writeTransaction } from '../db.ts'
import { resolveHostedUrl } from '../hosted-url.ts'
import { hostedWriteMode } from '../hosted-write-mode.ts'
import { credentials, Mcp } from '../mcp.ts'
import { queueHostedChange } from '../outbox.ts'
import { projectRecordIdFor } from '../project-record-id.ts'
import { projects } from '../projects.ts'
import { HOSTED_STATUS_EVENT_TABLE, HOSTED_TASK_TABLE } from '../push-contract.ts'
import { reconcileParentRecordId, resolveParentRecordId } from '../task-cache.ts'
import { collectorTaskShouldQueue } from '../task-hosted-row.ts'
import { claimTaskIdentity } from '../task-identity.ts'
import type { TaskRow } from '../task-row.ts'
import {
  type HostedTaskWriteOptions,
  hostedTaskChangeSendOptions,
} from '../task-write-destination.ts'
import { applyHostedCollectorPass, sendTrackerPlans } from './tracker-hosted-collector.ts'
import { dropLocalTrackerRows, retireLocalTrackerRows } from './tracker-local-collector.ts'
import {
  type ExistingTrackerTask,
  type TrackerObservationTimes,
  trackerObservationTimes,
  trackerTaskDiffers,
} from './tracker-observation-times.ts'
import {
  TRACKER_SINCE_OVERLAP_MS,
  type TrackerReadMode,
  trackerReadMode,
} from './tracker-read-mode.ts'
import { type TrackerTaskRowPlan, trackerTaskRowPlan } from './tracker-row-plan.ts'

export type { TrackerTask } from '../../../shared/trackers.ts'

async function resolveCached(
  namespace: string,
  refs: AssigneeRef[],
  lookup: (id: string, taskKey?: string) => Promise<string | null>,
): Promise<(string | null)[]> {
  const key = `tracker.assignees.${namespace}`
  const stored = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key = ?`)
    .get(key)
  let entries: [string, string | null][] = []
  try {
    entries = stored ? JSON.parse(stored.value) : []
  } catch {
    /* rebuild invalid cache */
  }
  const cache = new Map(entries)
  const before = cache.size
  const out = await resolveAssigneeIds(refs, cache, lookup)
  if (cache.size !== before) {
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, JSON.stringify([...cache])),
    )
  }
  return out
}

type TrackerRegistration =
  | { project: Project; prefixes: readonly string[]; source: TrackerSource; error?: never }
  | { project: Project; source?: never; error: string }

/** Keep invalid tracker declarations as failures instead of filtering them away. */
export function trackerRegistrations(rows: ReturnType<typeof projects>): TrackerRegistration[] {
  const registrations: TrackerRegistration[] = []
  for (const project of rows) {
    if (!project.settings.tracker) continue
    try {
      const source = trackerSourceFor(project, resolveCached)
      if (source)
        registrations.push({
          project: project.name,
          prefixes: project.settings.keyPrefixes ?? [],
          source,
        })
    } catch (cause) {
      registrations.push({
        project: project.name,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return registrations
}

export type TrackerResult = {
  project: Project
  tasks: number
  changed: number
  mode?: TrackerReadMode
  deleted?: number
  retired?: number
  /** Rows in this read whose tracker response omitted the parent field. */
  unreportedParents?: number
  /** Reported parent keys whose canonical task identity is ambiguous. */
  ambiguousParents?: number
  ambiguousParentKeys?: string[]
  /** Whether any tracker-owned row differed from the last successful read. */
  activity?: boolean
  skipped?: string
  error?: string
}

export function trackerLegError(results: TrackerResult[]): string | null {
  const failures = results.filter((result) => result.error)
  return failures.length
    ? failures.map((result) => `${result.project}: ${result.error}`).join('; ')
    : null
}

export async function trackerCredentials(
  project: Project,
  env: string,
  read: typeof credentials = credentials,
): Promise<
  | { project: Project; credentials: { url: string; token: string } | null }
  | { project: Project; error: string }
> {
  try {
    return { project, credentials: await read(env) }
  } catch (cause) {
    return {
      project,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export const trackerProjects = () =>
  projects()
    .filter((project) => {
      if (!project.settings.tracker) return false
      try {
        return trackerSourceFor(project) !== null
      } catch {
        // Keep malformed remote declarations scheduled so collection reports their refusal.
        return true
      }
    })
    .map((project) => project.name)

const BACKFILL_RESULT = 'backfill'

/** True for a tracker project that was read successfully, never the synthetic backfill row. */
export const successfulTrackerRead = (result: TrackerResult) =>
  result.project !== BACKFILL_RESULT && !result.error && !result.skipped

const trackerReadKey = (project: Project) => `collect.tracker.${project}.at`
const trackerSinceKey = (project: Project) => `collect.tracker.${project}.since`
const trackerFullReadKey = (project: Project) => `collect.tracker.${project}.full-at`
const trackerForceFullKey = (project: Project) => `collect.tracker.${project}.force-full`

function trackerSetting(key: string): string | null {
  return (
    db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)
      ?.value ?? null
  )
}

export function storedTrackerReadMode(
  source: TrackerSource,
  now: string,
): {
  mode: TrackerReadMode
  since: string | null
} {
  const since = trackerSetting(trackerSinceKey(source.project))
  return {
    mode: trackerReadMode({
      declared: source.supportsUpdatedSince,
      forceFull: trackerSetting(trackerForceFullKey(source.project)) !== null,
      since,
      lastFullRead: trackerSetting(trackerFullReadKey(source.project)),
      now,
    }),
    since,
  }
}

export function recordTrackerReadState(
  project: Project,
  mode: TrackerReadMode,
  startedAt: string,
  complete: boolean,
): void {
  writeTransaction((conn) => {
    if (!complete) {
      conn
        .query(`INSERT OR REPLACE INTO setting(key,value) VALUES (?,?)`)
        .run(trackerForceFullKey(project), '1')
      return
    }
    const since = new Date(Date.parse(startedAt) - TRACKER_SINCE_OVERLAP_MS).toISOString()
    const write = conn.query(`INSERT OR REPLACE INTO setting(key,value) VALUES (?,?)`)
    write.run(trackerSinceKey(project), since)
    if (mode === 'full') write.run(trackerFullReadKey(project), startedAt)
    conn.query('DELETE FROM setting WHERE key=?').run(trackerForceFullKey(project))
  })
}

export function trackerReadPassComplete(
  fetchedComplete: boolean,
  rejectedChanges: readonly string[],
): boolean {
  return fetchedComplete && rejectedChanges.length === 0
}

export function trackerProjectsReadSince(
  projectNames: readonly Project[],
  cutoffMs: number,
): Set<Project> {
  const fresh = new Set<Project>()
  const read = db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
  for (const project of projectNames) {
    const value = read.get(trackerReadKey(project))?.value
    if (value && Date.parse(value) >= cutoffMs) fresh.add(project)
  }
  return fresh
}

const TRACKER_LABEL_COLLISION = 'tracker label collision'

type TrackerIdentityRow = ExistingTrackerTask & {
  record_id: string
  next_document_number: number
  source: TaskRow['source']
  project_record_id: string | null
  parent_record_id: string | null
  body: string | null
}

const TRACKER_IDENTITY_COLUMNS =
  'record_id,next_document_number,key,source,external_id,project,project_record_id,parent_key,parent_record_id,body,title,status,status_category,opened_at,closed_at,first_seen,last_seen,updated_at,assignee,retired_reason'

function trackerIdentityRow(conn: Database, t: TrackerTask): TrackerIdentityRow | null {
  let row = t.externalId
    ? conn
        .query<TrackerIdentityRow, [string, string]>(
          `SELECT ${TRACKER_IDENTITY_COLUMNS} FROM task WHERE project=? AND external_id=?`,
        )
        .get(t.project, t.externalId)
    : null

  if (!row && t.externalId) {
    row = conn
      .query<TrackerIdentityRow, [string, string]>(
        `SELECT ${TRACKER_IDENTITY_COLUMNS} FROM task
         WHERE project=? AND key=? AND external_id IS NULL`,
      )
      .get(t.project, t.key)
  }
  if (!row && !t.externalId) {
    row = conn
      .query<TrackerIdentityRow, [string, string]>(
        `SELECT ${TRACKER_IDENTITY_COLUMNS} FROM task WHERE project=? AND key=?`,
      )
      .get(t.project, t.key)
  }
  return row
}

function trackerLabelAfterCollisionCheck(
  conn: Database,
  t: TrackerTask,
  row: TrackerIdentityRow,
): string {
  const collision =
    row.key === t.key
      ? null
      : conn
          .query<{ record_id: string }, [string, string, string]>(
            'SELECT record_id FROM task WHERE project=? AND key=? AND record_id<>?',
          )
          .get(t.project, t.key, row.record_id)
  if (collision) {
    console.error(
      `tracker label collision project=${t.project} external_id=${t.externalId} incoming=${t.key} held_by=${collision.record_id}; keeping ${row.key}`,
    )
    conn
      .query(
        `INSERT INTO task_identity_migration_repairs
           (table_name,row_id,task_key,old_record_id,new_record_id,old_external_id,new_external_id,reason,projects)
         VALUES ('task',?,?,?,?,?,?,?,?)
         ON CONFLICT(table_name,row_id,reason) DO UPDATE SET
           task_key=excluded.task_key,old_record_id=excluded.old_record_id,
           new_record_id=excluded.new_record_id,old_external_id=excluded.old_external_id,
           new_external_id=excluded.new_external_id,projects=excluded.projects`,
      )
      .run(
        row.record_id,
        t.key,
        row.record_id,
        collision.record_id,
        row.external_id,
        t.externalId,
        TRACKER_LABEL_COLLISION,
        t.project,
      )
    return row.key
  }
  conn
    .query(
      `DELETE FROM task_identity_migration_repairs
       WHERE table_name='task' AND row_id=? AND reason=?`,
    )
    .run(row.record_id, TRACKER_LABEL_COLLISION)
  return t.key
}

function plannedTrackerLabel(conn: Database, task: TrackerTask, row: TrackerIdentityRow | null) {
  if (!row || row.key === task.key) return task.key
  const collision = conn
    .query<{ record_id: string }, [string, string, string]>(
      'SELECT record_id FROM task WHERE project=? AND key=? AND record_id<>?',
    )
    .get(task.project, task.key, row.record_id)
  return collision ? row.key : task.key
}

export function planTrackerTaskOn(
  conn: Database,
  task: TrackerTask,
  at: string,
): TrackerTaskRowPlan {
  const stored = trackerIdentityRow(conn, task)
  const effectiveKey = plannedTrackerLabel(conn, task, stored)
  const parentResolution =
    task.parentKey === undefined || task.parentKey === null
      ? { recordId: null, ambiguous: false }
      : resolveParentRecordId(conn, task.parentKey, task.project)
  return trackerTaskRowPlan({
    task,
    stored,
    effectiveKey,
    parentRecordId: parentResolution.recordId,
    parentAmbiguous: parentResolution.ambiguous,
    at,
    projectRecordId: stored?.project_record_id ?? projectRecordIdFor(task.project),
  })
}

export function applyTrackerPlanOn(conn: Database, plan: TrackerTaskRowPlan): void {
  if (plan.stored?.source === 'local') return
  const row = plan.row
  conn
    .query(
      `INSERT INTO task
       (record_id,external_id,key,project,project_record_id,title,status,status_category,
        opened_at,updated_at,assignee,closed_at,source,first_seen,last_seen,parent_key,
        parent_record_id,body,next_document_number,retired_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(record_id) DO UPDATE SET
        external_id=excluded.external_id,key=excluded.key,project=excluded.project,
        project_record_id=excluded.project_record_id,title=excluded.title,status=excluded.status,
        status_category=excluded.status_category,opened_at=excluded.opened_at,
        updated_at=excluded.updated_at,assignee=excluded.assignee,closed_at=excluded.closed_at,
        source=excluded.source,first_seen=excluded.first_seen,last_seen=excluded.last_seen,
        parent_key=excluded.parent_key,parent_record_id=excluded.parent_record_id,
        body=excluded.body,next_document_number=excluded.next_document_number,
        retired_reason=excluded.retired_reason`,
    )
    .run(
      row.record_id,
      row.external_id,
      row.key,
      row.project,
      row.project_record_id ?? null,
      row.title,
      row.status,
      row.status_category,
      row.opened_at,
      row.updated_at,
      row.assignee,
      row.closed_at,
      row.source,
      row.first_seen,
      row.last_seen,
      row.parent_key,
      row.parent_record_id,
      row.body,
      row.next_document_number,
      row.retired_reason,
    )
  if (plan.stored)
    trackerLabelAfterCollisionCheck(conn, plan.task, plan.stored as TrackerIdentityRow)
  const childResolution = reconcileParentRecordId(conn, row.key, row.project)
  if (childResolution.ambiguous && !plan.ambiguousParentKeys.includes(row.key))
    plan.ambiguousParentKeys.push(row.key)
  refreshTrackerClaim(conn, plan.task, plan.event?.at ?? row.last_seen)
  if (plan.event)
    conn
      .query(
        `INSERT OR IGNORE INTO task_status_event
         (record_id,task_key,task_record_id,at,from_status,to_status,actor_user_id,actor_name,agent,run_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        plan.event.record_id,
        plan.event.task_key,
        plan.event.task_record_id,
        plan.event.at,
        plan.event.from_status,
        plan.event.to_status,
        null,
        null,
        null,
        null,
      )
}

function updateTrackerTask(
  conn: Database,
  t: TrackerTask,
  row: TrackerIdentityRow,
  effectiveKey: string,
  at: string,
  times: TrackerObservationTimes,
  parentRecordId: string | null,
) {
  const parentReported = t.parentKey !== undefined
  conn
    .query(
      `UPDATE task SET external_id=COALESCE(?,external_id), key=?, title=?, status=?,
         status_category=?, opened_at=?, updated_at=?, assignee=?, closed_at=?,
         source='mcp', last_seen=?, retired_reason=NULL,
         parent_key=CASE WHEN ? THEN ? ELSE parent_key END,
         parent_record_id=CASE WHEN ? THEN ? ELSE parent_record_id END
       WHERE record_id=?`,
    )
    .run(
      t.externalId,
      effectiveKey,
      t.title,
      t.status,
      t.category,
      times.openedAt,
      times.updatedAt,
      t.assignee,
      times.closedAt,
      at,
      parentReported,
      t.parentKey ?? null,
      parentReported,
      parentRecordId,
      row.record_id,
    )
}

function insertTrackerTask(
  conn: Database,
  t: TrackerTask,
  times: TrackerObservationTimes,
  parentRecordId: string | null,
) {
  conn
    .query(
      `INSERT INTO task (record_id, external_id, key, project, project_record_id, title, status, status_category,
        opened_at, updated_at, assignee, closed_at, source, first_seen, last_seen, parent_key,parent_record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'mcp', ?, ?, ?, ?)`,
    )
    .run(
      newRecordId(),
      t.externalId,
      t.key,
      t.project,
      projectRecordIdFor(t.project),
      t.title,
      t.status,
      t.category,
      times.openedAt,
      times.updatedAt,
      t.assignee,
      times.closedAt,
      times.firstSeen,
      times.lastSeen,
      t.parentKey ?? null,
      parentRecordId,
    )
}

function refreshTrackerClaim(conn: Database, t: TrackerTask, at: string) {
  const resolved = t.externalId
    ? conn
        .query<{ key: string; external_id: string }, [string, string]>(
          'SELECT key,external_id FROM task WHERE project=? AND external_id=?',
        )
        .get(t.project, t.externalId)
    : conn
        .query<{ key: string; external_id: string | null }, [string, string]>(
          'SELECT key,external_id FROM task WHERE project=? AND key=?',
        )
        .get(t.project, t.key)
  if (resolved?.external_id) {
    claimTaskIdentity(conn, {
      project: t.project,
      externalId: resolved.external_id,
      key: resolved.key,
      at,
    })
  }
}

/** Write the tracker-owned fields without ever replacing a locally-owned task. */
function upsertTrackerTaskOn(conn: Database, t: TrackerTask, at: string) {
  const row = trackerIdentityRow(conn, t)
  if (row?.source === 'local') {
    return {
      stored: row,
      times: trackerObservationTimes(t, row, at, row.key),
      changed: false,
      ambiguousParentKeys: [],
    }
  }
  const effectiveKey = row ? trackerLabelAfterCollisionCheck(conn, t, row) : t.key
  const changed = trackerTaskDiffers(t, row ?? undefined, effectiveKey)
  const times = trackerObservationTimes(t, row ?? undefined, at, effectiveKey)
  const parentResolution =
    t.parentKey === undefined || t.parentKey === null
      ? { recordId: null, ambiguous: false }
      : resolveParentRecordId(conn, t.parentKey, t.project)
  if (row) updateTrackerTask(conn, t, row, effectiveKey, at, times, parentResolution.recordId)
  else insertTrackerTask(conn, t, times, parentResolution.recordId)
  const childResolution = reconcileParentRecordId(conn, effectiveKey, t.project)
  refreshTrackerClaim(conn, t, at)
  const ambiguousParentKeys = new Set<string>()
  if (parentResolution.ambiguous && t.parentKey) ambiguousParentKeys.add(t.parentKey)
  if (childResolution.ambiguous) ambiguousParentKeys.add(effectiveKey)
  return { stored: row, times, changed, ambiguousParentKeys: [...ambiguousParentKeys] }
}

export type TrackerTaskObservation = {
  at: string
  taskRecordId: string | null
  taskKey: string
  event: {
    recordId: string
    fromCategory: string
    toCategory: string
  } | null
}

type CachedTrackerTaskObservation = TrackerTaskObservation & {
  times: TrackerObservationTimes
  changed: boolean
  ambiguousParentKeys: string[]
  priorCategory: string | null
}

/** Observe one tracker row and its category transition in the same transaction. */
function observeTrackerTaskOn(
  conn: Database,
  task: TrackerTask,
  at: string,
  queueSite: string | undefined,
): CachedTrackerTaskObservation {
  const { stored, times, changed, ambiguousParentKeys } = upsertTrackerTaskOn(conn, task, at)
  const was = stored?.status_category ?? null
  const recordsTransition =
    stored !== null &&
    stored.source !== 'local' &&
    stored.status_category !== null &&
    stored.status_category !== task.category

  const observed = trackerIdentityRow(conn, task)
  const taskRecordId = observed?.source === 'local' ? null : (observed?.record_id ?? null)
  const taskKey = observed?.key ?? task.key
  if (
    taskRecordId &&
    collectorTaskShouldQueue('mcp', observed, changed || stored?.updated_at === null)
  )
    queueHostedChange(conn, HOSTED_TASK_TABLE, taskRecordId, 'upsert', at, null, queueSite)
  if (!recordsTransition)
    return {
      at,
      taskRecordId,
      taskKey,
      times,
      changed,
      ambiguousParentKeys,
      priorCategory: was,
      event: null,
    }

  const recordId = newRecordId()
  const inserted = conn
    .query(
      `INSERT OR IGNORE INTO task_status_event
       (record_id,task_key,task_record_id,at,from_status,to_status,actor_user_id,actor_name,agent,run_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(recordId, task.key, taskRecordId!, at, was, task.category, null, null, null, null)
  const event =
    inserted.changes > 0 ? { recordId, fromCategory: was!, toCategory: task.category } : null
  if (event)
    queueHostedChange(
      conn,
      HOSTED_STATUS_EVENT_TABLE,
      event.recordId,
      'upsert',
      at,
      null,
      queueSite,
    )
  return {
    at,
    taskRecordId,
    taskKey,
    times,
    changed,
    ambiguousParentKeys,
    priorCategory: was,
    event,
  }
}

export async function observeTrackerTask(
  task: TrackerTask,
  at = nowIso(),
  prefixes: readonly string[],
  options?: HostedTaskWriteOptions & { afterTrackerSend?: () => void },
): Promise<TrackerTaskObservation> {
  if (!trackerKeyInScope(task.key, prefixes)) {
    return { at, taskRecordId: null, taskKey: task.key, event: null }
  }
  const hosted = hostedWriteMode(options?.baseUrl ?? resolveHostedUrl()) === 'hosted-configured'
  if (hosted) {
    const plan = planTrackerTaskOn(db(), task, at)
    const sent = await sendTrackerPlans([plan], options)
    if (sent.rejected.length)
      throw new Error(
        `hosted tracker changes were refused: ${sent.rejected.join('; ')}; ` +
          `refresh the task with \`${hostedTaskChangeSendOptions(task.key, task.project, options).conflictRemedy}\` and retry`,
      )
    options?.afterTrackerSend?.()
    writeTransaction((conn) => applyTrackerPlanOn(conn, plan))
    return {
      at,
      taskRecordId: plan.stored?.source === 'local' ? null : plan.row.record_id,
      taskKey: plan.row.key,
      event: plan.event
        ? {
            recordId: plan.event.record_id,
            fromCategory: plan.event.from_status!,
            toCategory: plan.event.to_status,
          }
        : null,
    }
  }
  const cached = writeTransaction((conn) => {
    const {
      times: _times,
      changed: _changed,
      priorCategory,
      ...observation
    } = observeTrackerTaskOn(conn, task, at, 'trackers.observeTrackerTask')
    return { observation, priorCategory }
  })
  return cached.observation
}

export async function fetchTrackerTasks(
  source: TrackerSource,
  client: ToolCaller,
  mode: TrackerReadMode,
  since: string | null,
  prefixes: readonly string[],
): Promise<TrackerFetchResult> {
  const fetched = await source.fetch(
    client,
    mode === 'incremental' ? (since ?? undefined) : undefined,
  )
  const tasks = fetched.tasks
  if (mode === 'incremental') return fetched
  const seen = new Set([...tasks.map((task) => task.key), ...fetched.deletedKeys])
  const vanished = db()
    .query<{ key: string }, [string]>(
      `SELECT key FROM task
       WHERE project = ? AND source = 'mcp'
         AND status_category IN ('open','active','review')`,
    )
    .all(source.project)
    .filter((row) => !seen.has(row.key))
    .filter((row) => trackerKeyInScope(row.key, prefixes))
  for (const { key } of vanished.slice(0, 200)) {
    try {
      const task = source.lookup ? await lookupTrackerTask(source, client, key) : null
      if (task) tasks.push(task)
    } catch {
      /* unfindable: leave it as it was rather than guess */
    }
  }
  return { ...fetched, tasks }
}

async function lookupTrackerTask(
  source: TrackerSource,
  client: ToolCaller,
  key: string,
): Promise<TrackerTask | null> {
  try {
    return await source.lookup!(client, key)
  } catch (cause) {
    if (cause instanceof TrackerLookupUnverifiable) return null
    throw cause
  }
}

type TrackerCacheObservation = {
  task: TrackerTask
  observation: CachedTrackerTaskObservation
}

export function writeTrackerCache(
  tasks: Iterable<TrackerTask>,
  at: string,
  prefixes: readonly string[],
): TrackerCacheObservation[] {
  const observations: TrackerCacheObservation[] = []
  writeTransaction((conn) => {
    for (const task of tasks) {
      if (!trackerKeyInScope(task.key, prefixes)) continue
      observations.push({
        task,
        observation: observeTrackerTaskOn(conn, task, at, undefined),
      })
    }
  })
  return observations
}

/** The prefix used by the register to scope a tracker key. */
export const trackerKeyPrefix = (key: string) => key.split('-', 1)[0]!

/** Whether the register admits a tracker key for this project. */
export function trackerKeyInScope(key: string, prefixes: readonly string[]): boolean {
  if (!prefixes.length) return true
  const prefix = trackerKeyPrefix(key).toLowerCase()
  return prefixes.some((declared) => declared.toLowerCase() === prefix)
}

function scopedTrackerTasks(tasks: TrackerTask[], prefixes: readonly string[]) {
  return new Map(
    tasks.filter((task) => trackerKeyInScope(task.key, prefixes)).map((task) => [task.key, task]),
  )
}

function unreportedParentCount(tasks: Iterable<TrackerTask>): number {
  return [...tasks].filter((task) => task.parentKey === undefined).length
}

function ambiguousParentSummary(observations: TrackerCacheObservation[], backfillKeys: string[]) {
  const keys = [
    ...new Set([
      ...observations.flatMap(({ observation }) => observation.ambiguousParentKeys),
      ...backfillKeys,
    ]),
  ].sort()
  return { ambiguousParents: keys.length, ambiguousParentKeys: keys }
}

/** Retire tracker rows the register no longer assigns to this project. */
export function retireOutOfScopeTrackerTasks(
  project: Project,
  prefixes: readonly string[],
  at: string,
): number {
  return retireLocalTrackerRows(project, prefixes, at, trackerKeyPrefix, applyTrackerPlanOn)
}

/** Reconcile tracker-reported deletions without deleting the local cache row. */
export function dropDeletedTrackerTasks(
  project: Project,
  keys: Iterable<string>,
  at: string,
  prefixes: readonly string[],
): { dropped: number; activity: boolean; changed: number } {
  return dropLocalTrackerRows(
    project,
    keys,
    at,
    prefixes,
    trackerKeyPrefix,
    planTrackerTaskOn,
    applyTrackerPlanOn,
  )
}

async function backfillTrackerTasks(
  source: TrackerSource,
  client: Mcp,
  missing: { task_key: string; project: string }[],
  at: string,
  prefixes: readonly string[],
): Promise<{ filled: number; activity: boolean; ambiguousParentKeys: string[] }> {
  let filled = 0
  let activity = false
  const ambiguousParentKeys = new Set<string>()
  if (!source.lookup) return { filled, activity, ambiguousParentKeys: [] }
  for (const { task_key } of missing.filter((row) => row.project === source.project)) {
    if (!trackerKeyInScope(task_key, prefixes)) continue
    try {
      const task = await lookupTrackerTask(source, client, task_key)
      if (!task) continue
      const { changed, ambiguousParentKeys: taskAmbiguities } = writeTransaction((conn) => {
        const result = upsertTrackerTaskOn(conn, task, at)
        const stored = trackerIdentityRow(conn, task)
        if (
          stored &&
          collectorTaskShouldQueue(
            'mcp',
            stored,
            result.changed || result.stored?.updated_at === null,
          )
        )
          queueHostedChange(
            conn,
            HOSTED_TASK_TABLE,
            stored.record_id,
            'upsert',
            at,
            null,
            undefined,
          )
        return result
      })
      filled++
      if (changed) activity = true
      for (const key of taskAmbiguities) ambiguousParentKeys.add(key)
    } catch {
      /* not findable; its work remains project-level unattributed */
    }
  }
  return { filled, activity, ambiguousParentKeys: [...ambiguousParentKeys] }
}

async function hostedBackfillReads(
  source: TrackerSource,
  client: Mcp,
  missing: { task_key: string; project: string }[],
  prefixes: readonly string[],
): Promise<TrackerTask[]> {
  if (!source.lookup) return []
  const tasks: TrackerTask[] = []
  for (const { task_key } of missing.filter((row) => row.project === source.project)) {
    if (!trackerKeyInScope(task_key, prefixes)) continue
    try {
      const task = await lookupTrackerTask(source, client, task_key)
      if (task) tasks.push(task)
    } catch {
      /* not findable; its work remains project-level unattributed */
    }
  }
  return tasks
}

function recentIntervalsNeedingTracker(conn: Database) {
  return conn
    .query<{ task_key: string; project: string }, []>(
      `SELECT DISTINCT i.task_key, i.project
       FROM interval i LEFT JOIN task t ON t.record_id=i.task_record_id
      WHERE i.task_key IS NOT NULL
        AND t.key IS NULL
        AND i.start_at >= datetime('now', '-30 days')`,
    )
    .all()
}

export function finishTrackerResults(
  results: { result: TrackerResult; filled: number }[],
  at: string,
): TrackerResult[] {
  const filled = results.reduce((sum, item) => sum + item.filled, 0)
  const out = results.map((item) => item.result)
  if (filled) out.push({ project: BACKFILL_RESULT, tasks: filled, changed: 0, activity: true })
  const successfulProjects = out.filter(successfulTrackerRead)
  if (successfulProjects.length)
    writeTransaction((conn) => {
      const write = conn.query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      for (const result of successfulProjects) write.run(trackerReadKey(result.project), at)
    })
  if (!trackerLegError(out))
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO setting (key, value) VALUES ('collect.trackers.at', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(JSON.stringify(at)),
    )
  return out
}

function trackerIngestInputs(only: ReadonlySet<Project> | null) {
  const trackers = trackerRegistrations(projects()).filter(
    (tracker) => !only || only.has(tracker.project),
  )
  return { trackers, missing: recentIntervalsNeedingTracker(db()) }
}

type CollectedTracker = { result: TrackerResult; filled: number }

async function collectTrackerSource(
  tracker: Extract<TrackerRegistration, { source: TrackerSource }>,
  missing: { task_key: string; project: string }[],
  at: string,
  m: Mcp,
): Promise<CollectedTracker> {
  const s = tracker.source
  const startedAt = nowIso()
  const read = storedTrackerReadMode(s, startedAt)
  const prefixes = tracker.prefixes
  const fetched = await fetchTrackerTasks(s, m, read.mode, read.since, prefixes)
  const unique = scopedTrackerTasks(fetched.tasks, prefixes)
  const hosted = hostedWriteMode(resolveHostedUrl()) === 'hosted-configured'
  const hostedBackfill = hosted ? await hostedBackfillReads(s, m, missing, prefixes) : []
  const applied = hosted
    ? await applyHostedCollectorPass({
        source: s,
        tasks: unique.values(),
        deletedKeys: fetched.deletedKeys,
        backfillTasks: hostedBackfill,
        prefixes,
        at,
        ports: {
          conn: db(),
          planTask: (task) => planTrackerTaskOn(db(), task, at),
          applyPlans: (plans) =>
            writeTransaction((conn) => {
              for (const plan of plans) applyTrackerPlanOn(conn, plan)
            }),
          inScope: (key) => trackerKeyInScope(key, prefixes),
          prefix: trackerKeyPrefix,
        },
      })
    : null
  const observations = applied?.observations ?? writeTrackerCache(unique.values(), at, prefixes)
  const retired = applied?.retired ?? retireOutOfScopeTrackerTasks(s.project, prefixes, at)
  const deletions =
    applied?.deletions ?? dropDeletedTrackerTasks(s.project, fetched.deletedKeys, at, prefixes)
  const backfill = applied?.backfill ?? (await backfillTrackerTasks(s, m, missing, at, prefixes))
  recordTrackerReadState(
    s.project,
    read.mode,
    startedAt,
    trackerReadPassComplete(fetched.complete, applied?.rejected ?? []),
  )
  return {
    result: {
      project: s.project,
      tasks: unique.size,
      changed:
        deletions.changed + observations.filter(({ observation }) => observation.event).length,
      activity:
        deletions.activity ||
        backfill.activity ||
        observations.some(({ observation }) => observation.changed),
      mode: read.mode,
      deleted: deletions.dropped,
      retired,
      unreportedParents: unreportedParentCount(unique.values()),
      ...ambiguousParentSummary(observations, backfill.ambiguousParentKeys),
      ...(applied?.rejected.length
        ? { error: `hosted tracker changes were refused: ${applied.rejected.join('; ')}` }
        : {}),
    },
    filled: backfill.filled,
  }
}

async function collectTracker(
  tracker: TrackerRegistration,
  missing: { task_key: string; project: string }[],
  at: string,
): Promise<CollectedTracker> {
  if ('error' in tracker)
    return {
      result: { project: tracker.project, tasks: 0, changed: 0, error: tracker.error },
      filled: 0,
    }
  const s = tracker.source
  const resolved = await trackerCredentials(s.project, s.env)
  if ('error' in resolved)
    return {
      result: { project: s.project, tasks: 0, changed: 0, error: resolved.error },
      filled: 0,
    }
  if (!resolved.credentials)
    return {
      result: {
        project: s.project,
        tasks: 0,
        changed: 0,
        skipped: `no ${s.env}_MCP_URL / _TOKEN in the environment, either env file, or hosted secrets`,
      },
      filled: 0,
    }
  const m = new Mcp(resolved.credentials.url, resolved.credentials.token)
  try {
    await m.initialize()
    return await collectTrackerSource(tracker, missing, at, m)
  } catch (cause) {
    return {
      result: { project: s.project, tasks: 0, changed: 0, error: String((cause as Error).message) },
      filled: 0,
    }
  } finally {
    await m.close()
  }
}

/** Snapshot every reachable tracker into the task table, recording transitions. */
export async function ingestTrackers(only: ReadonlySet<Project> | null = null) {
  const at = nowIso()
  const { trackers, missing } = trackerIngestInputs(only)
  return finishTrackerResults(
    await Promise.all(trackers.map((tracker) => collectTracker(tracker, missing, at))),
    at,
  )
}
