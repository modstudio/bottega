// concern: context-health
/** Gathers context health facts through the owning read services. */
import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CONTEXT_HOLDER_KINDS,
  type ContextHolderKind,
} from '../../../shared/context-item-vocabulary.ts'
import { sessionProjectRows } from '../board/board-store.ts'
import { db, nowIso } from '../database/db.ts'
import { scopeContextHolders } from '../doc/context-service.ts'
import { docHasRepositoryReferences } from '../doc/doc-lint.ts'
import { lintStoredDoc } from '../doc/doc-lint-adapter.ts'
import { projects } from '../project/projects.ts'
import { TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { briefInjectionWindow } from '../session/brief-injection.ts'
import { contextReviewWindow } from '../session/context-review-store.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { liveRunCursorIds } from '../workflow/workflow-cursor-list.ts'
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
  for (const candidate of selected) {
    try {
      rows.push(...(await readHubTasks(candidate.name)))
    } catch (error) {
      throw new ProjectTaskReadError(candidate.name, error)
    }
  }
  return rows
}

class ProjectTaskReadError extends Error {
  readonly project: string

  constructor(project: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ProjectTaskReadError'
    this.project = project
  }
}

function staleReferenceFacts(body: string, project: string | null, projectRegistered: boolean) {
  if (!docHasRepositoryReferences(body) || !projectRegistered)
    return { referenceFindings: [], unverifiable: null }
  if (!project)
    return { referenceFindings: [], unverifiable: 'item has no recorded project checkout' }
  const findings = lintStoredDoc({
    scope: 'project',
    subject: project,
    slug: 'context-health-item',
    body,
    kind: 'working',
    status: 'current',
    summary: null,
  })
  const referenceFindings = findings.map(({ rule, message }) => ({ rule, message }))
  const unavailable = findings.find((finding) => finding.rule === 'doc/reference-unverifiable')
  return { referenceFindings, unverifiable: unavailable?.message ?? null }
}

function failureFacts(now: string, since: string, error: unknown): ContextHealthFacts {
  return {
    now,
    since,
    items: [],
    tasks: [],
    cursorStages: [],
    liveRunCursorIds: [],
    reviews: [],
    briefs: [],
    unreachable: {
      resource:
        error instanceof ProjectTaskReadError ? 'project task data' : 'architect context store',
      detail: error instanceof Error ? error.message : String(error),
      remedy:
        error instanceof ProjectTaskReadError
          ? `run ${PLATFORM_SLUG} task list --project ${error.project} --json`
          : `run ${PLATFORM_SLUG} record doctor; sign in when it reports a missing or expired record session, or run ${PLATFORM_SLUG} machine update when it reports a behind store; then retry`,
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
  tasks: readonly HubTaskReference[],
  cursorById: ReadonlyMap<string, CursorOwner>,
  sessionProject: ReadonlyMap<string, string | null>,
  options: ContextHealthOptions,
  registeredProjects: ReadonlySet<string>,
): ContextHealthItem[] {
  const taskById = new Map(tasks.map((task) => [task.record_id, task]))
  const items: ContextHealthItem[] = []
  for (const holderKind of CONTEXT_HOLDER_KINDS) {
    for (const holder of scopeContextHolders(holderKind)) {
      const { task, session, project } = holderIdentity(
        holderKind,
        holder.holderId,
        taskById,
        cursorById,
        sessionProject,
      )
      if (options.project && project !== options.project) continue
      if (options.session && session !== options.session) continue
      const projectRegistered = project === null || registeredProjects.has(project)
      for (const item of holder.items) {
        items.push({
          holder: holder.holder,
          holderId: holder.holderId,
          holderKind,
          id: item.id,
          recordId: item.recordId,
          kind: item.kind,
          body: item.body,
          updatedAt: item.updatedAt,
          project,
          taskKey: task?.key ?? null,
          taskStatus: task?.status_category ?? null,
          projectRegistered,
          ...staleReferenceFacts(item.body, project, projectRegistered),
        })
      }
    }
  }
  return items
}

function recordedMeasurements(since: string, session: string | undefined) {
  const selectedSession = <Row extends { sessionId: string }>(row: Row) =>
    !session || row.sessionId === session
  const reviews = contextReviewWindow(since).filter(selectedSession)
  const briefs = briefInjectionWindow(since).filter(selectedSession)
  return { reviews, briefs }
}

async function gatherContextHealthFacts(
  options: ContextHealthOptions,
  generatedAt: string,
  since: string,
): Promise<ContextHealthFacts> {
  const tasks = await taskRows(options.project)
  const flowStore = taskFlowReadStore(db())
  const cursorRows = await flowStore.listStages({
    ...(options.project ? { project: options.project } : {}),
    states: TASK_FLOW_STAGE_STATES,
  })
  const cursorById = new Map(cursorRows.map((cursor) => [cursor.record_id, cursor]))
  const sessionProject = new Map(sessionProjectRows().map((row) => [row.sessionId, row.project]))
  const registeredProjects = new Set(projects().map((project) => project.name))
  const items = holderItems(tasks, cursorById, sessionProject, options, registeredProjects)
  const { reviews, briefs } = recordedMeasurements(since, options.session)
  return {
    now: generatedAt,
    since,
    items,
    tasks: tasks.map(({ key, project, parent_key }) => ({ key, project, parent_key })),
    cursorStages: cursorRows.map((cursor) => ({
      recordId: cursor.record_id,
      project: cursor.project,
      taskKey: cursor.workflow_key || null,
      state: cursor.state,
    })),
    liveRunCursorIds: liveRunCursorIds(cursorRows.map((cursor) => cursor.record_id)),
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
