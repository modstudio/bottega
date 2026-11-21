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
import type { StepLandAction } from '../workflow/workflow-step-action.ts'

type HeldTaskCursor = {
  number: number
  project: string
  workflowSlug: string
  workflowKey: string
  stepSlug: string
  actions: readonly string[]
}

export type PullRequestTaskCursorAdmission = { kind: 'allow' } | { kind: 'refuse'; message: string }

export function decidePullRequestTaskCursorAdmission(input: {
  command: 'pr create' | 'pr merge'
  project: string
  taskKey: string | null
  harnessSession: string | null
  heldCursors: readonly HeldTaskCursor[]
}): PullRequestTaskCursorAdmission {
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
  },
  readOpenCursors: (database: Database, session: string) => Promise<HeldTaskCursor[]> = async (
    database,
    session,
  ) =>
    (await openQuestionStages(database, session)).map((cursor) => ({
      number: cursor.number,
      project: cursor.project,
      workflowSlug: cursor.workflow_slug,
      workflowKey: cursor.workflow_key,
      stepSlug: cursor.step_slug,
      actions: cursor.step_actions,
    })),
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
  })
  if (decision.kind === 'refuse') throw new Error(decision.message)
}
