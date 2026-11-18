// concern: task close residue
/** Reports cleanup that remains after a task close write has succeeded. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { OpenWorkflowCursor } from '../../shared/orch-contract.ts'
import type { TaskRow } from './task-row.ts'

export type TaskClosedResidue = 'cursor-abandon' | 'claim-release' | 'branch-prune'

export class TaskClosedWithResidueError extends Error {
  readonly task: TaskRow
  readonly residue: TaskClosedResidue

  constructor(task: TaskRow, residue: TaskClosedResidue, message: string) {
    super(message)
    this.name = 'TaskClosedWithResidueError'
    this.task = task
    this.residue = residue
  }
}

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export function taskCursorAbandonResidue(
  task: TaskRow,
  status: string,
  cursor: OpenWorkflowCursor,
  cause: unknown,
): TaskClosedWithResidueError {
  const owner = cursor.session_id ? ` --owner-session ${cursor.session_id}` : ''
  const reason = `task ${task.key} closed (${status})`
  const remedy = `${PLATFORM_SLUG} workflow abandon ${cursor.workflow_slug} --cursor ${cursor.id} --project ${cursor.project ?? task.project}${owner} --reason "${reason}"`
  return new TaskClosedWithResidueError(
    task,
    'cursor-abandon',
    `task ${task.key} is closed; workflow cursor cleanup did not finish: ${detailOf(cause)}\nclear it with: ${remedy}`,
  )
}

export function taskClaimReleaseResidue(task: TaskRow, cause: unknown): TaskClosedWithResidueError {
  const detail = detailOf(cause)
  const marker = `${PLATFORM_SLUG} `
  const remedyAt = detail.lastIndexOf(marker)
  const remedy =
    remedyAt >= 0 ? detail.slice(remedyAt) : `${PLATFORM_SLUG} board claim release-task ${task.key}`
  return new TaskClosedWithResidueError(
    task,
    'claim-release',
    `task ${task.key} is closed; claim release did not finish: ${detail}\nclear it with: ${remedy}`,
  )
}

export function taskBranchPruneResidue(task: TaskRow, cause: unknown): TaskClosedWithResidueError {
  return new TaskClosedWithResidueError(
    task,
    'branch-prune',
    `task ${task.key} is closed; branch prune did not finish: ${detailOf(cause)}\nclear it with: ${PLATFORM_SLUG} tree branch prune --project ${task.project} --key ${task.key}`,
  )
}
