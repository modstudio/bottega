// concern: pull-request-task-cursor-admission
/** Requires harness pull-request work to run on the task cursor named by its branch. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { taskKeyToken } from '../branch/other-branch-state.ts'
import { classifyCaller, resolveCallerIdentity } from '../caller-classification.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { openQuestionStages } from '../question-store/question-store-read.ts'
import { canonMirrorBranchName, isSystemLifecycleJob } from '../run/synthetic-lifecycle-job.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { closedStepsFromTrail } from '../workflow/workflow-cursor-trail.ts'
import type { StepLandAction } from '../workflow/workflow-step-action.ts'
import { decidePullRequestClassGuard } from './pr-class-guard.ts'

type HeldTaskCursor = {
  number: number
  project: string
  workflowSlug: string
  workflowKey: string
  stepSlug: string
  actions: readonly string[]
  closed?: string
  args?: string
}

export type PullRequestTaskCursorAdmission = { kind: 'allow' } | { kind: 'refuse'; message: string }

export function decidePullRequestTaskCursorAdmission(input: {
  command: 'pr create' | 'pr merge'
  project: string
  taskKey: string | null
  harnessSession: string | null
  heldCursors: readonly HeldTaskCursor[]
  systemJob: string | null
  branch: string
  canonMirrorBranch: string | null
}): PullRequestTaskCursorAdmission {
  if (
    isSystemLifecycleJob(input.systemJob) &&
    input.canonMirrorBranch !== null &&
    input.branch === input.canonMirrorBranch
  )
    return { kind: 'allow' }
  if (!input.taskKey || !input.harnessSession) return { kind: 'allow' }
  const matching = input.heldCursors.filter(
    (cursor) => cursor.project === input.project && cursor.workflowKey === input.taskKey,
  )
  if (matching.length) {
    const required: StepLandAction = input.command === 'pr create' ? 'pr-create' : 'pr-merge'
    if (matching.some((cursor) => cursor.actions.includes(required))) return { kind: 'allow' }
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          matching
            .map(
              (cursor) =>
                `refusing ${PLATFORM_SLUG} ${input.command}: cursor ${cursor.number} (${cursor.workflowSlug}, ${cursor.workflowKey}) is at step ${cursor.stepSlug}, which does not run ${input.command}`,
            )
            .join('\n'),
          matching.map((cursor) => ({
            kind: 'command' as const,
            argv: [
              PLATFORM_SLUG,
              'workflow',
              'next',
              cursor.workflowSlug,
              '--cursor',
              String(cursor.number),
              '--project',
              cursor.project,
              '--arg',
              `key=${cursor.workflowKey}`,
            ],
          })),
        ),
      ),
    }
  }
  return {
    kind: 'refuse',
    message: renderRefusal(
      refusal(
        `refusing ${PLATFORM_SLUG} ${input.command} because harness session ${input.harnessSession} does not hold an open workflow cursor for project ${input.project} and task ${input.taskKey}`,
        {
          kind: 'edit',
          text: `run ${PLATFORM_SLUG} workflow compose ship-task --project ${input.project} --arg key=${input.taskKey} --arg branch=<branch> --arg worktree=<worktree>`,
        },
      ),
    ),
  }
}

export async function assertPullRequestTaskCursorAdmission(
  input: {
    command: 'pr create' | 'pr merge'
    project: Project
    branch: string
    database?: Database
    env?: Record<string, string | undefined>
    systemJob?: string | null
    body?: string
  },
  readOpenCursors: (database: Database, session: string) => Promise<HeldTaskCursor[]> = async (
    database,
    session,
  ) =>
    Promise.all(
      (await openQuestionStages(database, session)).map(async (cursor) => {
        const stage = await taskFlowReadStore(database).stageByRecordId(cursor.record_id)
        return {
          number: cursor.number,
          project: cursor.project,
          workflowSlug: cursor.workflow_slug,
          workflowKey: cursor.workflow_key,
          stepSlug: cursor.step_slug,
          actions: cursor.step_actions,
          closed: stage?.closed,
          args: stage?.args,
        }
      }),
    ),
): Promise<void> {
  const caller = classifyCaller(input.env ?? process.env)
  const identity = caller.kind === 'harness' ? resolveCallerIdentity(caller, null) : null
  const harnessSession = identity?.kind === 'identity' ? identity.session : null
  const taskKey = taskKeyToken(input.branch, input.project.settings.keyPrefixes ?? [])
  const database = input.database ?? db()
  const heldCursors =
    taskKey && harnessSession ? await readOpenCursors(database, harnessSession) : []
  const decision = decidePullRequestTaskCursorAdmission({
    command: input.command,
    project: input.project.name,
    taskKey,
    harnessSession,
    heldCursors,
    systemJob: input.systemJob ?? null,
    branch: input.branch,
    canonMirrorBranch: input.project.settings.canonMirrorKey?.trim()
      ? canonMirrorBranchName(input.project.settings.canonMirrorKey.trim())
      : null,
  })
  if (decision.kind === 'refuse') throw new Error(decision.message)
  if (input.command !== 'pr create') return
  const cursor = heldCursors.find(
    (item) =>
      item.project === input.project.name &&
      item.workflowKey === taskKey &&
      item.workflowSlug === 'fix-defect' &&
      item.closed,
  )
  if (!cursor?.closed) return
  const closed = closedStepsFromTrail(cursor.closed)
  const measured = closed.find((step) => step.slug === 'measure-class')
  if (!measured) return
  const values = Object.fromEntries(
    (measured.evidence ?? []).map((item) => [item.flag, item.value]),
  )
  const command = values['--command']
  const count = Number(values['--count'])
  if (!command || !Number.isInteger(count)) return
  const implementClosedAt = closed.findLast((step) => step.slug === 'implement-fix')?.at
  const rows = database
    .query<
      { command: string; output_tail: string; exit_code: number; created_at: string },
      [string]
    >(
      "SELECT command,output_tail,exit_code,created_at FROM probe WHERE kind='exec' AND session_id=? ORDER BY created_at DESC",
    )
    .all(harnessSession ?? '')
    .map((row) => ({
      command: recordedCommand(row.command),
      output: row.output_tail,
      exitCode: row.exit_code,
      createdAt: row.created_at,
    }))
  const args = cursor.args ? (JSON.parse(cursor.args) as Record<string, string>) : {}
  const classGuard = decidePullRequestClassGuard({
    applies: true,
    body: input.body ?? '',
    measurement: { className: values['--class'] ?? '', command, count },
    implementClosedAt,
    execs: rows,
    worktree: args.worktree ?? '<worktree>',
  })
  if (classGuard.kind === 'refuse') throw new Error(classGuard.message)
}

function recordedCommand(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value) && value.every((part) => typeof part === 'string'))
      return value.join(' ')
  } catch {
    // Legacy command records are already text.
  }
  return raw
}
