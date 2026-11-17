// concern: context-service
/** Gathers and renders the compact architect context brief. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ContextItemKind } from '../../../shared/context-item-vocabulary.ts'
import { gitAt } from '../../../shared/git.ts'
import { type ClaimView, liveClaimsOfSession } from '../board/board-claim-service.ts'
import { claimNotices } from '../board/board-service.ts'
import { pullRequestNumberForBranch } from '../branch/task-key-pull-request.ts'
import { db } from '../database/db.ts'
import { filedIssueQueueState } from '../issue/issue-dispatch.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { openQuestionsForTasks } from '../question-store/question-store-read.ts'
import {
  type QuestionInboxCounts,
  questionInboxCountsForSession,
} from '../run/question-inbox-counts.ts'
import { LIVE_RUN_STATUS_SQL } from '../run/run-status.ts'
import { KEYLESS_CURSOR_IDLE_MS, keylessCursorIdle } from '../session/keyless-cursor-idle.ts'
import { sessionReviewVerdictLines } from '../session/session-review-verdicts.ts'
import { architectSessionContext } from '../workflow/session-context.ts'
import { workflowCursorReference } from '../workflow/workflow-cursor-format.ts'
import {
  listWorkflowCursors,
  type WorkflowCursorListRow,
} from '../workflow/workflow-cursor-list.ts'
import {
  workflowCursorBranchAndWorktree,
  workflowCursorClaimHandles,
} from '../workflow/workflow-cursor-worktrees.ts'
import {
  type HubTaskReference,
  projectTaskKey,
  readHubTasks,
  taskKeyMap,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'
import {
  type ContextBriefCursorLine,
  contextBriefWorktreePath,
  formatContextBriefCursorLine,
  formatContextBriefRunLine,
} from './context-brief-format.ts'
import { storedItems, taskProfile } from './context-write-adapter.ts'
import type { ContextItem } from './doc-context-write.ts'
import { cursorContextHolder, taskContextHolder } from './doc-subjects.ts'
import { listOpenResumes } from './docs.ts'

type ContextBriefHolder = {
  key: string
  title: string
  kind: 'session' | 'cursor' | 'task' | 'epic'
  items: ContextItem[]
  openQuestions?: Array<{ number: number; question: string }>
  openQuestionsUnavailable?: string
}

export type ContextBrief = {
  session: string
  fullCommand: string
  holders: ContextBriefHolder[]
  runs: Array<{ number: number; job: string; status: string; label: string | null }>
  cursors: Array<
    ContextBriefCursorLine & {
      recordId: string
      project: string
      keylessIdle?: string | null
      keylessIdleMs?: number | null
    }
  >
  claims: Array<{ kind: string; value: string }>
  reviewVerdictLines?: string[]
  waiting: {
    boardRequests: number
    questions: QuestionInboxCounts | null
    filedIssues: number
    resumeBriefs: number
  }
  autonomy: string
}

const ITEM_ORDER: readonly ContextItemKind[] = ['ruling', 'position', 'fact', 'pointer']

const firstLine = (body: string) => body.split(/\r\n|\r|\n/, 1)[0]!.trim()
const count = (value: number, singular: string, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`

function waitingQuestionLine(counts: QuestionInboxCounts | null): string {
  if (counts === null)
    return `could not read question inbox (${PLATFORM_SLUG} question inbox --all --active)`
  const groups = [
    counts.worker ? count(counts.worker, 'worker question') : null,
    counts.user ? `${counts.user} on you` : null,
    counts.foreign ? `${counts.foreign} other sessions'` : null,
    counts.unowned ? `${counts.unowned} unowned` : null,
  ].filter((group): group is string => group !== null)
  if (!groups.length) return '0 questions'
  return `${groups.join(' · ')} (${PLATFORM_SLUG} question inbox --all --active)`
}

function renderItem(item: ContextItem): string {
  const label = item.kind === 'ruling' ? `ruling ${item.source}` : item.kind
  const body = firstLine(item.body)
  return `  ${label}: ${item.kind === 'ruling' ? JSON.stringify(body) : body}`
}

function renderOpenQuestions(holder: ContextBriefHolder): string[] {
  if (holder.kind === 'cursor') return []
  if (holder.openQuestionsUnavailable) return [`  open: ${holder.openQuestionsUnavailable}`]
  const questions = (holder.openQuestions ?? []).map(
    (question) => `  open: ${firstLine(question.question)}`,
  )
  return questions.length ? questions : ['  open: none']
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
    lines.push(...renderOpenQuestions(holder))
  }
  const inFlight = [
    ...brief.cursors.map((cursor) => {
      if (cursor.keylessIdle !== undefined)
        return `cursor ${cursor.number} ${cursor.workflow} · ${cursor.keylessIdle ?? 'idle unknown'}${cursor.questionNumber === null && cursor.keylessIdleMs !== null && cursor.keylessIdleMs !== undefined && cursor.keylessIdleMs >= KEYLESS_CURSOR_IDLE_MS ? ` → ${PLATFORM_SLUG} workflow abandon${workflowCursorReference(cursor.number, cursor.project).cli}` : cursor.questionNumber === null ? '' : `, awaiting q${cursor.questionNumber}`}`
      return formatContextBriefCursorLine(cursor)
    }),
    ...brief.runs.map(formatContextBriefRunLine),
    ...brief.claims.map((claim) => `unbound claim ${claim.kind}:${claim.value}`),
  ]
  if (inFlight.length) lines.push('In flight:', ...inFlight.map((line) => `  ${line}`))
  else lines.push('In flight: none')
  lines.push(...(brief.reviewVerdictLines ?? []))
  lines.push(
    `Waiting: ${count(brief.waiting.boardRequests, 'board request')} (${PLATFORM_SLUG} board read) · ` +
      `${waitingQuestionLine(brief.waiting.questions)} · ` +
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
      project: string
    })

/** Decide holder order from task facts only; store reads are applied after this decision. */
export function holderSequence(
  session: string,
  working: readonly ContextBriefWorkingKey[],
  tasks: readonly HubTaskReference[],
  keylessCursors: readonly {
    record_id: string
    id: number
    workflow_slug: string
    mode_slug: string
    project: string
  }[] = [],
): ContextBriefHolderReference[] {
  const holders: ContextBriefHolderReference[] = [
    { key: session, title: '', kind: 'session' },
    ...keylessCursors.map((cursor) => ({
      key: cursorContextHolder(cursor.record_id),
      title: `Cursor ${cursor.id} ${cursor.workflow_slug} ${cursor.mode_slug} (${cursor.project})`,
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
      project: task.project,
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

export async function storedBriefHolders(
  references: readonly ContextBriefHolderReference[],
  database: Database,
): Promise<ContextBriefHolder[]> {
  const taskReferences = references.filter(
    (reference): reference is Extract<ContextBriefHolderReference, { kind: 'task' | 'epic' }> =>
      reference.kind === 'task' || reference.kind === 'epic',
  )
  const openByTask = new Map<string, Array<{ number: number; question: string }>>()
  const unresolvedProjects = new Set<string>()
  for (const projectName of new Set(taskReferences.map(({ project }) => project))) {
    const project = projectByName(projectName, database)
    if (!project) {
      unresolvedProjects.add(projectName)
      continue
    }
    const projectTasks = taskReferences.filter((reference) => reference.project === projectName)
    const rows = await openQuestionsForTasks(
      database,
      projectTasks.map(({ recordId }) => recordId),
      project.recordId,
    )
    for (const row of rows) {
      const taskId = String(row.workflow_task_record_id)
      const questions = openByTask.get(taskId) ?? []
      questions.push({ number: Number(row.number), question: String(row.question) })
      openByTask.set(taskId, questions)
    }
  }
  return (
    await Promise.all(
      references.map(async (reference) => {
        if (reference.kind === 'session') {
          return {
            ...reference,
            items: storedItems(`session:${reference.key}`, database),
          }
        }
        if (reference.kind === 'cursor') {
          const { recordId, ...holder } = reference
          return { ...holder, items: storedItems(cursorContextHolder(recordId), database) }
        }
        const { recordId, project: projectName, ...holder } = reference
        const openQuestions = openByTask.get(recordId) ?? []
        return {
          ...holder,
          items: storedItems(taskContextHolder(recordId), database),
          ...(unresolvedProjects.has(projectName)
            ? {
                openQuestionsUnavailable: `questions unread for unresolved project ${projectName}; register or refresh the project, then retry`,
              }
            : {}),
          ...(openQuestions.length ? { openQuestions } : {}),
        }
      }),
    )
  ).filter((holder) => holder.kind !== 'session' || holder.items.length > 0)
}

export function workingKeysForBrief(
  cursors: readonly Pick<WorkflowCursorListRow, 'workflow_key' | 'project'>[],
): ContextBriefWorkingKey[] {
  return cursors
    .filter((cursor) => Boolean(cursor.workflow_key))
    .map((cursor) => ({ key: cursor.workflow_key, project: cursor.project }))
}

function claimBoundToCursor(
  claim: Pick<ClaimView, 'project' | 'subject'>,
  cursors: readonly Pick<
    WorkflowCursorListRow,
    'record_id' | 'project' | 'workflow_key' | 'args'
  >[],
): boolean {
  return cursors.some((cursor) => {
    if (
      claim.subject.kind === 'task' &&
      claim.project === cursor.project &&
      claim.subject.value === cursor.workflow_key
    )
      return true
    return workflowCursorClaimHandles(cursor.args).includes(claim.subject.value)
  })
}

type BriefLiveRun = ContextBrief['runs'][number] & { cursor_record_id: string | null }

/** Gather one cursor's display handles without storing facts that can go stale. */
export function contextBriefCursorHandles(
  cursor: Pick<WorkflowCursorListRow, 'workflow_key' | 'project' | 'args'>,
  database: Database = db(),
): Pick<ContextBrief['cursors'][number], 'key' | 'branch' | 'worktree' | 'tip' | 'pr'> {
  const { branch, worktree } = workflowCursorBranchAndWorktree(cursor.args)
  const tipResult = worktree ? gitAt(worktree, ['rev-parse', '--short', 'HEAD']) : null
  const mainCheckout = projectByName(cursor.project, database)?.path ?? null
  return {
    key: cursor.workflow_key.trim() || null,
    branch,
    worktree: worktree ? contextBriefWorktreePath(worktree, mainCheckout) : null,
    tip: tipResult?.code === 0 && tipResult.stdout.trim() ? tipResult.stdout.trim() : null,
    pr: branch ? pullRequestNumberForBranch(cursor.project, branch, database) : null,
  }
}

/** Assign live runs and claims to their cursor or unbound brief bucket. */
export function selectBriefInFlight(
  liveRuns: readonly BriefLiveRun[],
  cursors: readonly Pick<
    WorkflowCursorListRow,
    'record_id' | 'project' | 'workflow_key' | 'args'
  >[],
  liveClaims: readonly Pick<ClaimView, 'project' | 'subject'>[],
) {
  return {
    runs: liveRuns
      .filter((run) => !cursors.some((cursor) => cursor.record_id === run.cursor_record_id))
      .map(({ cursor_record_id: _, ...run }) => run),
    cursorRuns: cursors.map((cursor) => ({
      recordId: cursor.record_id,
      runs: liveRuns
        .filter((run) => run.cursor_record_id === cursor.record_id)
        .map((run) => run.number),
    })),
    claims: liveClaims
      .filter((claim) => !claimBoundToCursor(claim, cursors))
      .map((claim) => claim.subject),
  }
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
  const keylessCursors = cursors.filter((cursor) => !cursor.workflow_key)
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
      `SELECT number,job,status,COALESCE(label,prompt_head) AS label,cursor_record_id FROM run
       WHERE session_id=? AND status IN ${LIVE_RUN_STATUS_SQL} ORDER BY number`,
    )
    .all(session) as Array<ContextBrief['runs'][number] & { cursor_record_id: string | null }>
  const questionCounts = await questionInboxCountsForSession(session, database)
  const boardEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: session }
  const boardRequests = claimNotices(true, boardEnv, Date.now(), database).filter(
    (notice) => notice.purpose === 'request',
  ).length
  const references = holderSequence(session, working, taskRows, keylessCursors)
  const holders = await storedBriefHolders(references, database)
  const fullHolder = holders.find((holder) => holder.kind === 'task' || holder.kind === 'epic')
  const inFlight = selectBriefInFlight(liveRuns, cursors, liveClaims)
  return {
    session,
    fullCommand: fullHolder
      ? `${PLATFORM_SLUG} agent context show --task ${fullHolder.key}`
      : `${PLATFORM_SLUG} agent context show --session ${session}`,
    holders,
    runs: inFlight.runs,
    cursors: cursors.map((cursor) => {
      const idle = cursor.workflow_key ? null : keylessCursorIdle(cursor.updated_at)
      return {
        recordId: cursor.record_id,
        number: cursor.id,
        ...contextBriefCursorHandles(cursor, database),
        workflow: cursor.workflow_slug,
        project: cursor.project,
        mode: cursor.mode_slug,
        step: cursor.ordinal + 1,
        totalSteps: cursor.total_steps,
        stepSlug: cursor.step_slug,
        questionNumber: cursor.question_number,
        runs: inFlight.cursorRuns.find((item) => item.recordId === cursor.record_id)?.runs ?? [],
        ...(cursor.workflow_key
          ? {}
          : { keylessIdle: idle?.label ?? null, keylessIdleMs: idle?.ms ?? null }),
      }
    }),
    claims: inFlight.claims,
    reviewVerdictLines: sessionReviewVerdictLines(session, cursors, database),
    waiting: {
      boardRequests,
      questions: questionCounts,
      filedIssues: filedIssues.waiting.length,
      resumeBriefs: listOpenResumes(cwd).open.length,
    },
    autonomy: autonomyLine(autonomy),
  }
}
