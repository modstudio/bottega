// concern: context-health
/** Gathers context health facts through the owning read services. */
import type { Database } from 'bun:sqlite'
import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CONTEXT_HOLDER_KINDS,
  type ContextHolderKind,
} from '../../../shared/context-item-vocabulary.ts'
import { db, nowIso } from '../database/db.ts'
import { scopeContextHolders } from '../doc/context-service.ts'
import { docHasRepositoryReferences, STALE_REFERENCE_RULES } from '../doc/doc-lint.ts'
import { lintStoredDoc } from '../doc/doc-lint-adapter.ts'
import { projects } from '../project/projects.ts'
import { isOpenStageState, TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { LIVE_RUN_STATUS_SQL } from '../run/run-status.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { type HubTaskReference, readHubTasks } from '../workflow/workflow-task-reference.ts'
import { type ContextHealthFacts, type ContextHealthItem, contextHealth } from './context-health.ts'

export type ContextHealthOptions = { since?: string; project?: string; session?: string }

function selectedSince(value: string | undefined, now: number): string {
  const duration = parseBoardDuration(value ?? '7d')
  return new Date(now - duration).toISOString()
}

async function taskRows(project: string | undefined): Promise<HubTaskReference[]> {
  const selected = projects().filter((candidate) => !project || candidate.name === project)
  const rows: HubTaskReference[] = []
  for (const candidate of selected) rows.push(...(await readHubTasks(candidate.name)))
  return rows
}

function staleReferenceFacts(body: string, project: string | null) {
  if (!docHasRepositoryReferences(body)) return { staleReferences: [], unverifiable: null }
  if (!project)
    return { staleReferences: [], unverifiable: 'item has no recorded project checkout' }
  const findings = lintStoredDoc({
    scope: 'project',
    subject: project,
    slug: 'context-health-item',
    body,
    kind: 'working',
    status: 'current',
    summary: null,
  })
  const staleReferences = findings
    .filter(
      (finding) => STALE_REFERENCE_RULES.has(finding.rule) && finding.rule !== 'doc/line-anchor',
    )
    .map(({ rule, message }) => ({ rule, message }))
  const unavailable = findings.find((finding) => finding.rule === 'doc/reference-unverifiable')
  return { staleReferences, unverifiable: unavailable?.message ?? null }
}

function failureFacts(now: string, since: string, error: unknown): ContextHealthFacts {
  return {
    now,
    since,
    items: [],
    tasks: [],
    openCursors: [],
    reviews: [],
    briefs: [],
    unreachable: {
      resource: 'architect context store',
      detail: error instanceof Error ? error.message : String(error),
      remedy: `run ${PLATFORM_SLUG} record doctor; sign in when it reports a missing or expired record session, or run ${PLATFORM_SLUG} machine update when it reports a behind store; then retry`,
    },
  }
}

type CursorOwner = {
  record_id: string
  project: string
  session_id: string | null
  workflow_key: string | null
}

function holderIdentity(
  holderKind: ContextHolderKind,
  holderId: string,
  taskById: ReadonlyMap<string, HubTaskReference>,
  cursorById: ReadonlyMap<string, CursorOwner>,
  sessionProject: ReadonlyMap<string, string | null>,
) {
  const task = holderKind === 'task' ? (taskById.get(holderId) ?? null) : null
  const cursor = holderKind === 'cursor' ? (cursorById.get(holderId) ?? null) : null
  const session = holderKind === 'session' ? holderId : (cursor?.session_id ?? null)
  const project =
    task?.project ?? cursor?.project ?? (session ? (sessionProject.get(session) ?? null) : null)
  return { task, session, project }
}

function holderItems(
  database: Database,
  tasks: readonly HubTaskReference[],
  cursorById: ReadonlyMap<string, CursorOwner>,
  sessionProject: ReadonlyMap<string, string | null>,
  options: ContextHealthOptions,
): ContextHealthItem[] {
  const taskById = new Map(tasks.map((task) => [task.record_id, task]))
  const items: ContextHealthItem[] = []
  for (const holderKind of CONTEXT_HOLDER_KINDS) {
    for (const holder of scopeContextHolders(holderKind, database)) {
      const { task, session, project } = holderIdentity(
        holderKind,
        holder.holderId,
        taskById,
        cursorById,
        sessionProject,
      )
      if (options.project && project !== options.project) continue
      if (options.session && session !== options.session) continue
      for (const item of holder.items) {
        items.push({
          holder: holder.holder,
          holderKind,
          id: item.id,
          recordId: item.recordId,
          kind: item.kind,
          body: item.body,
          updatedAt: item.updatedAt,
          project,
          taskKey: task?.key ?? null,
          taskStatus: task?.status_category ?? null,
          ...staleReferenceFacts(item.body, project),
        })
      }
    }
  }
  return items
}

function recordedMeasurements(database: Database, since: string, session: string | undefined) {
  const selectedSession = <Row extends { session_id: string }>(row: Row) =>
    !session || row.session_id === session
  const reviews = database
    .query<{ session_id: string; at: string; items: number; flagged: number }, [string]>(
      'SELECT session_id,at,items,flagged FROM context_review WHERE at>=? ORDER BY session_id,at',
    )
    .all(since)
    .filter(selectedSession)
    .map((row) => ({
      sessionId: row.session_id,
      at: row.at,
      items: row.items,
      flagged: row.flagged,
    }))
  const briefs = database
    .query<
      { session_id: string; at: string; source: string; cursors: number; over_cap: number },
      [string]
    >(
      'SELECT session_id,at,source,cursors,over_cap FROM brief_injection WHERE at>=? ORDER BY session_id,at',
    )
    .all(since)
    .filter(selectedSession)
    .map((row) => ({
      sessionId: row.session_id,
      at: row.at,
      source: row.source,
      cursors: row.cursors,
      overCap: Boolean(row.over_cap),
    }))
  return { reviews, briefs }
}

async function gatherContextHealthFacts(
  options: ContextHealthOptions,
  generatedAt: string,
  since: string,
): Promise<ContextHealthFacts> {
  const database = db()
  const tasks = await taskRows(options.project)
  const flowStore = taskFlowReadStore(database)
  const cursorRows = await flowStore.listStages({
    ...(options.project ? { project: options.project } : {}),
    states: TASK_FLOW_STAGE_STATES,
  })
  const cursorById = new Map(cursorRows.map((cursor) => [cursor.record_id, cursor]))
  const sessionRows = database
    .query<{ session_id: string; project: string | null }, []>(
      'SELECT session_id,project FROM presence',
    )
    .all()
  const sessionProject = new Map(sessionRows.map((row) => [row.session_id, row.project]))
  const items = holderItems(database, tasks, cursorById, sessionProject, options)
  const openCursors = cursorRows
    .filter((cursor) => isOpenStageState(cursor.state))
    .map((cursor) => ({ project: cursor.project, taskKey: cursor.workflow_key || null }))
  const liveCursorIds = new Set(
    database
      .query<{ cursor_record_id: string }, []>(
        `SELECT DISTINCT cursor_record_id FROM run WHERE cursor_record_id IS NOT NULL AND status IN ${LIVE_RUN_STATUS_SQL}`,
      )
      .all()
      .map((run) => run.cursor_record_id),
  )
  const liveBound = cursorRows
    .filter((cursor) => liveCursorIds.has(cursor.record_id))
    .map((cursor) => ({ project: cursor.project, taskKey: cursor.workflow_key || null }))
  const { reviews, briefs } = recordedMeasurements(database, since, options.session)
  return {
    now: generatedAt,
    since,
    items,
    tasks: tasks.map(({ key, project, parent_key }) => ({ key, project, parent_key })),
    openCursors: [...openCursors, ...liveBound],
    reviews,
    briefs,
    unreachable: null,
  }
}

export async function contextHealthReport(options: ContextHealthOptions = {}) {
  const generatedAt = nowIso()
  const since = selectedSince(options.since, Date.parse(generatedAt))
  try {
    return contextHealth(await gatherContextHealthFacts(options, generatedAt, since))
  } catch (error) {
    return contextHealth(failureFacts(generatedAt, since, error))
  }
}
