// concern: context-service
/** Gathers and renders the compact architect context brief. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ContextItemKind } from '../../../shared/context-item-vocabulary.ts'
import { type ClaimView, liveClaimsOfSession } from '../board/board-claim-service.ts'
import { claimNotices } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import { filedIssueQueueState } from '../issue/issue-dispatch.ts'
import { projectAt } from '../project/projects.ts'
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
import { storedItems, taskProfile } from './context-write-adapter.ts'
import type { ContextItem } from './doc-context-write.ts'
import { taskContextHolder } from './doc-subjects.ts'
import { listOpenResumes } from './docs.ts'

type ContextBriefHolder = {
  key: string
  title: string
  kind: 'session' | 'cursor' | 'task' | 'epic'
  items: ContextItem[]
  openQuestions?: Array<{ number: number; question: string }>
}

export type ContextBrief = {
  session: string
  fullCommand: string
  holders: ContextBriefHolder[]
  runs: Array<{ number: number; job: string; status: string }>
  cursors: Array<{
    recordId: string
    number: number
    workflow: string
    mode: string
    step: number
    totalSteps: number
    stepSlug: string
    questionNumber: number | null
    runs: number[]
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
        : holder.kind === 'cursor'
          ? holder.title
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
    ...brief.cursors.map((cursor) => {
      const question = cursor.questionNumber === null ? '' : `, awaiting q${cursor.questionNumber}`
      const runs = cursor.runs.length ? `, runs ${cursor.runs.join(', ')}` : ''
      return `cursor ${cursor.number} ${cursor.workflow} ${cursor.mode} step ${cursor.step}/${cursor.totalSteps} ${cursor.stepSlug}${question}${runs}`
    }),
    ...brief.runs.map((run) => `unbound run ${run.number} ${run.job} ${run.status}`),
    ...brief.claims.map((claim) => `unbound claim ${claim.kind}:${claim.value}`),
  ]
  if (inFlight.length) lines.push('In flight:', ...inFlight.map((line) => `  ${line}`))
  else lines.push('In flight: none')
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
  | (Omit<ContextBriefHolder, 'items' | 'kind'> & { kind: 'cursor'; recordId: string })
  | (Omit<ContextBriefHolder, 'items' | 'kind'> & {
      kind: 'task' | 'epic'
      recordId: string
    })

/** Decide holder order from task facts only; store reads are applied after this decision. */
export function holderSequence(
  session: string,
  working: readonly ContextBriefWorkingKey[],
  tasks: readonly HubTaskReference[],
  keylessCursors: readonly Pick<
    WorkflowCursorListRow,
    'record_id' | 'id' | 'workflow_slug' | 'mode_slug'
  >[] = [],
): ContextBriefHolderReference[] {
  const holders: ContextBriefHolderReference[] = [
    { key: session, title: '', kind: 'session' },
    ...keylessCursors.map((cursor) => ({
      key: `cursor:${cursor.record_id}`,
      title: `Cursor ${cursor.id} ${cursor.workflow_slug} ${cursor.mode_slug}`,
      kind: 'cursor' as const,
      recordId: cursor.record_id,
    })),
  ]
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
      if (reference.kind === 'cursor') {
        const { recordId, ...holder } = reference
        return { ...holder, items: storedItems(`cursor:${recordId}`, database) }
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
  cursors: readonly Pick<WorkflowCursorListRow, 'workflow_key' | 'project'>[],
): ContextBriefWorkingKey[] {
  return cursors
    .filter((cursor) => Boolean(cursor.workflow_key))
    .map((cursor) => ({ key: cursor.workflow_key, project: cursor.project }))
}

function claimBoundToCursor(claim: ClaimView, cursors: readonly WorkflowCursorListRow[]): boolean {
  return cursors.some((cursor) => {
    if (
      claim.subject.kind === 'task' &&
      claim.project === cursor.project &&
      claim.subject.value === cursor.workflow_key
    )
      return true
    const args = JSON.parse(cursor.args) as Record<string, unknown>
    return [args.worktree, args.branch].some(
      (value) => typeof value === 'string' && value === claim.subject.value,
    )
  })
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
  const working = workingKeysForBrief(cursors)
  const workingProjects = [...new Set(working.map(({ project }) => project))]
  const [taskRows, autonomy, filedIssues] = await Promise.all([
    Promise.all(workingProjects.map((project) => readHubTasks(project))).then((rows) =>
      rows.flat(),
    ),
    architectSessionContext(cwd, { database }),
    filedIssueQueueState(projectAt(cwd, database)?.name ?? null),
  ])
  const liveRuns = database
    .query(
      `SELECT number,job,status,cursor_record_id FROM run
       WHERE session_id=? AND status IN ${LIVE_RUN_STATUS_SQL} ORDER BY number`,
    )
    .all(session) as Array<ContextBrief['runs'][number] & { cursor_record_id: string | null }>
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
  const references = holderSequence(
    session,
    working,
    taskRows,
    cursors.filter((cursor) => !cursor.workflow_key),
  )
  const holders = storedBriefHolders(references, database)
  const fullHolder = holders.find((holder) => holder.kind !== 'session')
  return {
    session,
    fullCommand: fullHolder
      ? `${PLATFORM_SLUG} agent context show --task ${fullHolder.key}`
      : `${PLATFORM_SLUG} agent context show --session ${session}`,
    holders,
    runs: liveRuns
      .filter((run) => !cursors.some((cursor) => cursor.record_id === run.cursor_record_id))
      .map(({ cursor_record_id: _, ...run }) => run),
    cursors: cursors.map((cursor) => ({
      recordId: cursor.record_id,
      number: cursor.id,
      workflow: cursor.workflow_slug,
      mode: cursor.mode_slug,
      step: cursor.ordinal + 1,
      totalSteps: cursor.total_steps,
      stepSlug: cursor.step_slug,
      questionNumber: cursor.question_number,
      runs: liveRuns
        .filter((run) => run.cursor_record_id === cursor.record_id)
        .map((run) => run.number),
    })),
    claims: liveClaims
      .filter((claim) => !claimBoundToCursor(claim, cursors))
      .map((claim) => claim.subject),
    waiting: {
      boardRequests,
      questions: runQuestions.count + cursorQuestions.count,
      filedIssues: filedIssues.waiting.length,
      resumeBriefs: listOpenResumes(cwd).open.length,
    },
    autonomy: autonomyLine(autonomy),
  }
}
