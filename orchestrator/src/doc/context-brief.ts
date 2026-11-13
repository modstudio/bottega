// concern: context-service
/** Gathers and renders the compact architect context brief. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ContextItemKind } from '../../../shared/context-item-vocabulary.ts'
import { type ClaimView, liveClaimsOfSession } from '../board/board-claim-service.ts'
import { claimNotices } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import { filedIssueQueueState } from '../issue/issue-dispatch.ts'
import { projectAt, projectForTaskKey, projects } from '../project/projects.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { LIVE_RUN_STATUS_SQL } from '../run/run-status.ts'
import { architectSessionContext } from '../workflow/session-context.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  listWorkflowCursors,
  type WorkflowCursorListRow,
} from '../workflow/workflow-cursor-list.ts'
import {
  type HubTaskReference,
  projectTaskKey,
  readHubTasks,
  taskKeyMap,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'
import { parseWorkedTaskKeys, WORKED_CONTEXT_ID, WORKED_CONTEXT_KIND } from './context-worked.ts'
import { storedItems, taskProfile } from './context-write-adapter.ts'
import type { ContextItem } from './doc-context-write.ts'
import { taskContextHolder } from './doc-subjects.ts'
import { listOpenResumes } from './docs.ts'

type ContextBriefHolder = {
  key: string
  title: string
  kind: 'session' | 'task' | 'epic'
  items: ContextItem[]
  openQuestions?: Array<{ number: number; question: string }>
}

export type ContextBrief = {
  session: string
  fullCommand: string
  holders: ContextBriefHolder[]
  runs: Array<{ number: number; job: string; status: string }>
  cursors: Array<{
    number: number
    workflow: string
    mode: string
    questionNumber: number | null
  }>
  claims: Array<{ kind: string; value: string }>
  waiting: {
    boardRequests: number
    questions: number
    filedIssues: number
    resumeBriefs: number
  }
  autonomy: string
}

const ITEM_ORDER: readonly ContextItemKind[] = ['ruling', 'position', 'fact', 'pointer']

const firstLine = (body: string) => body.split(/\r\n|\r|\n/, 1)[0]!.trim()
const count = (value: number, singular: string, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`

function renderItem(item: ContextItem): string {
  const label = item.kind === 'ruling' ? `ruling ${item.source}` : item.kind
  const body = firstLine(item.body)
  return `  ${label}: ${item.kind === 'ruling' ? JSON.stringify(body) : body}`
}

/** The fixed compact/resume layout; gathering facts is deliberately separate. */
export function renderContextBrief(brief: ContextBrief): string {
  const lines = [`Context (session ${brief.session}) · full: ${brief.fullCommand}`]
  for (const holder of brief.holders) {
    lines.push(
      holder.kind === 'session'
        ? `Session ${holder.key}`
        : `${holder.key} ${holder.title}`.trimEnd(),
    )
    const items = holder.items.toSorted(
      (left, right) =>
        ITEM_ORDER.indexOf(left.kind) - ITEM_ORDER.indexOf(right.kind) ||
        left.id.localeCompare(right.id),
    )
    for (const item of items) lines.push(renderItem(item))
    for (const question of holder.openQuestions ?? [])
      lines.push(`  open: ${firstLine(question.question)}`)
    if (!holder.openQuestions?.length) lines.push('  open: none')
  }
  const inFlight = [
    ...brief.runs.map((run) => `run ${run.number} ${run.job} ${run.status}`),
    ...brief.cursors.map((cursor) =>
      cursor.questionNumber === null
        ? `cursor ${cursor.number} ${cursor.workflow} ${cursor.mode}`
        : `cursor ${cursor.number} ${cursor.workflow} ${cursor.mode}, awaiting q${cursor.questionNumber}`,
    ),
    ...brief.claims.map((claim) => `claim ${claim.kind}:${claim.value}`),
  ]
  lines.push(`In flight: ${inFlight.join(' · ') || 'none'}`)
  lines.push(
    `Waiting: ${count(brief.waiting.boardRequests, 'board request')} (${PLATFORM_SLUG} board read) · ` +
      `${count(brief.waiting.questions, 'question')} · ` +
      `${count(brief.waiting.filedIssues, 'filed issue')} (${PLATFORM_SLUG} workflow fix-defect --waiting) · ` +
      `${count(brief.waiting.resumeBriefs, 'resume brief')} (${PLATFORM_SLUG} doc resumes)`,
  )
  lines.push(`Autonomy: ${brief.autonomy}`)
  return lines.join('\n')
}

export type ContextBriefWorkingKey = {
  key: string
  project: string
}

type ContextBriefHolderReference =
  | (Omit<ContextBriefHolder, 'items' | 'kind'> & { kind: 'session' })
  | (Omit<ContextBriefHolder, 'items' | 'kind'> & {
      kind: 'task' | 'epic'
      recordId: string
    })

/** Decide holder order from task facts only; store reads are applied after this decision. */
export function holderSequence(
  session: string,
  working: readonly ContextBriefWorkingKey[],
  tasks: readonly HubTaskReference[],
): ContextBriefHolderReference[] {
  const holders: ContextBriefHolderReference[] = [{ key: session, title: '', kind: 'session' }]
  const index = taskKeyMap(tasks)
  const emitted = new Set<string>()
  const add = (task: HubTaskReference, projectTasks: readonly HubTaskReference[]) => {
    const identity = projectTaskKey(task.project, task.key)
    if (emitted.has(identity)) return
    emitted.add(identity)
    holders.push({
      key: task.key,
      title: task.title ?? '',
      kind: taskProfile(task.key, projectTasks),
      recordId: task.record_id,
    })
  }
  for (const { key, project } of working) {
    const task = taskReferenceForProjectKey(index, project, key)
    if (!task) continue
    const projectTasks = tasks.filter((row) => row.project === project)
    add(task, projectTasks)
    let parent = task.parent_key ?? null
    while (parent) {
      const parentTask = taskReferenceForProjectKey(index, project, parent)
      if (!parentTask) break
      add(parentTask, projectTasks)
      parent = parentTask.parent_key ?? null
    }
  }
  return holders
}

export function storedBriefHolders(
  references: readonly ContextBriefHolderReference[],
  database: Database,
): ContextBriefHolder[] {
  return references
    .map((reference) => {
      if (reference.kind === 'session') {
        return {
          ...reference,
          items: storedItems(`session:${reference.key}`, database),
        }
      }
      const { recordId, ...holder } = reference
      const openQuestions = openTaskQuestions(recordId, database)
      return {
        ...holder,
        items: storedItems(taskContextHolder(recordId), database),
        ...(openQuestions.length ? { openQuestions } : {}),
      }
    })
    .filter((holder) => holder.kind !== 'session' || holder.items.length > 0)
}

/** Read only unanswered, unclosed questions bound to one task record. */
function openTaskQuestions(
  taskRecordId: string,
  database: Database,
): Array<{ number: number; question: string }> {
  return database
    .query<{ number: number; question: string }, [string]>(
      `SELECT number,question FROM question q
       WHERE workflow_task_record_id=? AND ${questionOpenSql('q')} ORDER BY number`,
    )
    .all(taskRecordId)
}

export function workingKeysForBrief(
  session: string,
  liveClaims: readonly Pick<ClaimView, 'project' | 'subject'>[],
  cursors: readonly Pick<WorkflowCursorListRow, 'workflow_key' | 'project'>[],
  database: Database,
): ContextBriefWorkingKey[] {
  const current: ContextBriefWorkingKey[] = [
    ...liveClaims
      .filter((claim) => claim.subject.kind === 'task')
      .map((claim) => ({ key: claim.subject.value, project: claim.project })),
    ...cursors
      .filter((cursor) => Boolean(cursor.workflow_key))
      .map((cursor) => ({ key: cursor.workflow_key, project: cursor.project })),
  ]
  const worked = storedItems(`session:${session}`, database).find(
    (item) => item.id === WORKED_CONTEXT_ID && item.kind === WORKED_CONTEXT_KIND,
  )
  if (!worked) return current
  const registered = projects(undefined, database)
  for (const key of parseWorkedTaskKeys(worked.body)) {
    const project = projectForTaskKey(key, registered)
    if (project) current.push({ key, project: project.name })
  }
  return current
}

function autonomyLine(context: Awaited<ReturnType<typeof architectSessionContext>>): string {
  if (!context.registered) return 'unknown'
  const grouped: Array<{ value: string; stages: string[] }> = []
  for (const stage of context.stages) {
    const value = stage.agreed ? stage.value : 'mixed'
    const existing = grouped.find((item) => item.value === value)
    if (existing) existing.stages.push(stage.stage)
    else grouped.push({ value, stages: [stage.stage] })
  }
  return [
    ...grouped.map((item) => `${item.stages.join(', ')} ${item.value}`),
    `ship ${context.shipTo.value}`,
  ].join(' · ')
}

export async function contextBrief(
  session: string,
  cwd = process.cwd(),
  database: Database = db(),
): Promise<ContextBrief> {
  const cursors = await listWorkflowCursors({ session }, database)
  const liveClaims = liveClaimsOfSession(session, Date.now(), database)
  const working = workingKeysForBrief(session, liveClaims, cursors, database)
  const workingProjects = [...new Set(working.map(({ project }) => project))]
  const [taskRows, autonomy, filedIssues] = await Promise.all([
    Promise.all(workingProjects.map((project) => readHubTasks(project))).then((rows) =>
      rows.flat(),
    ),
    architectSessionContext(cwd, { database }),
    filedIssueQueueState(projectAt(cwd, database)?.name ?? null),
  ])
  const runs = database
    .query(
      `SELECT number,job,status FROM run
       WHERE session_id=? AND status IN ${LIVE_RUN_STATUS_SQL} ORDER BY number`,
    )
    .all(session) as ContextBrief['runs']
  const runQuestions = database
    .query(
      `SELECT COUNT(*) count FROM question q JOIN run r ON r.record_id=q.run_record_id
       WHERE r.session_id=? AND ${questionOpenSql('q')}`,
    )
    .get(session) as { count: number }
  const cursorQuestions = {
    count: await taskFlowReadStore(database).openWorkflowQuestionCountForSession(session),
  }
  const boardEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: session }
  const boardRequests = claimNotices(true, boardEnv, Date.now(), database).filter(
    (notice) => notice.purpose === 'request',
  ).length
  const references = holderSequence(session, working, taskRows)
  const holders = storedBriefHolders(references, database)
  const fullHolder = holders.find((holder) => holder.kind !== 'session')
  return {
    session,
    fullCommand: fullHolder
      ? `${PLATFORM_SLUG} agent context show --task ${fullHolder.key}`
      : `${PLATFORM_SLUG} agent context show --session ${session}`,
    holders,
    runs,
    cursors: cursors.map((cursor) => ({
      number: cursor.id,
      workflow: cursor.workflow_slug,
      mode: cursor.mode_slug,
      questionNumber: cursor.question_number,
    })),
    claims: liveClaims.map((claim) => claim.subject),
    waiting: {
      boardRequests,
      questions: runQuestions.count + cursorQuestions.count,
      filedIssues: filedIssues.waiting.length,
      resumeBriefs: listOpenResumes(cwd).open.length,
    },
    autonomy: autonomyLine(autonomy),
  }
}
