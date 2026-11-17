// concern: workflow-task-claim
/** Keeps a task claim aligned with the task cursor that owns it. */

import { BOARD_CLAIM_DEFAULT_MS } from '../board/board-claim-policy.ts'
import {
  boardClaimReleaseTask,
  boardClaimTake,
  type BoardClaimResult,
} from '../board/board-operations.ts'
import type { Database } from 'bun:sqlite'
import { projectByName } from '../project/projects.ts'

export type TaskCursorClaimVerb = 'compose' | 'advance' | 'await' | 'rule' | 'finish' | 'abandon'

export type TaskCursorClaimDecision =
  | { action: 'none' }
  | { action: 'take'; project: string; key: string; session: string }
  | { action: 'release'; project: string; key: string; session: string }

export function decideTaskCursorClaim(input: {
  project: string
  taskKey: string | null
  session: string | null | undefined
  verb: TaskCursorClaimVerb
}): TaskCursorClaimDecision {
  if (!input.taskKey || !input.session) return { action: 'none' }
  if (input.verb === 'finish' || input.verb === 'abandon')
    return {
      action: 'release',
      project: input.project,
      key: input.taskKey,
      session: input.session,
    }
  return {
    action: 'take',
    project: input.project,
    key: input.taskKey,
    session: input.session,
  }
}

export type TaskCursorClaimPorts = {
  take(input: {
    project: string
    key: string
    session: string
  }): Promise<BoardClaimResult & { action: 'taken' | 'renewed' | 'taken-over' }>
  release(input: { project: string; key: string; session: string }): Promise<{ released: number }>
}

function productionPorts(database?: Database): TaskCursorClaimPorts {
  return {
    take: ({ project, key, session }) =>
      boardClaimTake(
        { project, subject: `task:${key}`, durationMs: BOARD_CLAIM_DEFAULT_MS },
        { taskCursorSession: session, database, cwd: projectByName(project, database)?.path },
      ),
    release: ({ project, key, session }) =>
      boardClaimReleaseTask(key, project, {
        taskCursorSession: session,
        database,
        cwd: projectByName(project, database)?.path,
      }),
  }
}

export async function followTaskCursorClaim(
  input: {
    project: string
    taskKey: string | null
    session: string | null | undefined
    verb: TaskCursorClaimVerb
    database?: Database
  },
  ports: TaskCursorClaimPorts = productionPorts(input.database),
): Promise<TaskCursorClaimDecision> {
  const decision = decideTaskCursorClaim(input)
  if (decision.action === 'take') await ports.take(decision)
  if (decision.action === 'release') await ports.release(decision)
  return decision
}

export function taskClaimReleaseWarning(project: string, key: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `warning: task cursor closed but its claim could not be released: ${detail}; run board claim release-task ${key} --project ${project}`
}
