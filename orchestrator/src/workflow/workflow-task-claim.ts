// concern: workflow-task-claim
/** Keeps a task claim aligned with the task cursor that owns it. */

import type { Database } from 'bun:sqlite'
import { BOARD_CLAIM_DEFAULT_MS } from '../board/board-claim-policy.ts'
import type { BoardClaimResult } from '../board/board-operation-results.ts'
import {
  boardClaimReleaseTask,
  boardClaimTake,
  boardOpenTaskCursorProject,
  boardQueuedClaimsRenew,
} from '../board/board-operations.ts'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import type { RenewTaskClaim } from '../run/run-task-claim-renewal.ts'

export type TaskCursorClaimVerb =
  | 'compose'
  | 'advance'
  | 'await'
  | 'rule'
  | 'finish'
  | 'abandon'
  | 'handoff'
  | 'renew'

export type TaskCursorClaimDecision =
  | { action: 'none' }
  | { action: 'take'; project: string; key: string; session: string }
  | { action: 'release'; project: string; key: string }

export function decideTaskCursorClaim(input: {
  project: string
  taskKey: string | null
  session: string | null | undefined
  verb: TaskCursorClaimVerb
}): TaskCursorClaimDecision {
  if (!input.taskKey) return { action: 'none' }
  if (input.verb === 'finish' || input.verb === 'abandon')
    return {
      action: 'release',
      project: input.project,
      key: input.taskKey,
    }
  if (!input.session) return { action: 'none' }
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
  release(input: { project: string; key: string }): Promise<{ released: number }>
}

function productionPorts(database?: Database): TaskCursorClaimPorts {
  return {
    take: ({ project, key, session }) =>
      boardClaimTake(
        { project, subject: `task:${key}`, durationMs: BOARD_CLAIM_DEFAULT_MS },
        {
          taskCursorAuthority: { mode: 'take', session },
          database,
          cwd: projectByName(project, database)?.path,
        },
      ),
    release: ({ project, key }) =>
      boardClaimReleaseTask(key, project, {
        taskCursorAuthority: { mode: 'release', session: null },
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
): Promise<{
  decision: TaskCursorClaimDecision
  claimAction?: 'taken' | 'renewed' | 'taken-over'
}> {
  const decision = decideTaskCursorClaim(input)
  if (decision.action === 'take') {
    const result = await ports.take(decision)
    return { decision, claimAction: result.action }
  }
  if (decision.action === 'release') await ports.release(decision)
  return { decision }
}

export async function followTaskCursorClaimWithWarning(input: {
  project: string
  taskKey: string | null
  session: string | null | undefined
  verb: TaskCursorClaimVerb
  database?: Database
}): Promise<string | null> {
  try {
    await followTaskCursorClaim(input)
    return null
  } catch (error) {
    return input.taskKey ? taskClaimFollowWarning(input.taskKey, error) : null
  }
}

export const renewTaskClaim: RenewTaskClaim = async (launchKey, session) => {
  if (!session) return
  const database = db()
  await boardQueuedClaimsRenew(session, Date.now(), database)
  if (!launchKey) return
  const project = await boardOpenTaskCursorProject(launchKey, session, database)
  if (!project) return
  await followTaskCursorClaim({
    project,
    taskKey: launchKey,
    session,
    verb: 'renew',
    database,
  })
}

export function taskClaimReleaseWarning(project: string, key: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `warning: task cursor closed but its claim could not be released: ${detail}; run board claim release-task ${key} --project ${project}`
}

export function taskClaimFollowWarning(key: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `warning: task cursor moved but its claim did not move: ${detail}; run workflow next for ${key} to retake it`
}
