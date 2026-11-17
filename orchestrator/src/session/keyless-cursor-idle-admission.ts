// concern: keyless cursor idle admission
/** Refuses new work while a harness session owns an unattended keyless cursor. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { classifyCaller, resolveCallerIdentity } from '../caller-classification.ts'
import { db } from '../database/db.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { workflowCursorReference } from '../workflow/workflow-cursor-format.ts'
import { KEYLESS_CURSOR_IDLE_MS, keylessCursorIdle } from './keyless-cursor-idle.ts'

export type IdleAdmissionCursor = {
  number: number
  project: string
  workflow: string
  key: string
  updatedAt: string
  questionNumber: number | null
}

export type KeylessCursorIdleAdmission =
  | { kind: 'allow' }
  | { kind: 'refuse'; message: string; cursor: number }

export function decideKeylessCursorIdleAdmission(input: {
  action: 'run start' | 'workflow compose' | 'task new'
  now: number
  cursors: readonly IdleAdmissionCursor[]
}): KeylessCursorIdleAdmission {
  const idle = input.cursors
    .filter((cursor) => !cursor.key && cursor.questionNumber === null)
    .map((cursor) => ({ cursor, idle: keylessCursorIdle(cursor.updatedAt, input.now) }))
    .filter(
      (item): item is { cursor: IdleAdmissionCursor; idle: NonNullable<typeof item.idle> } =>
        item.idle !== null && item.idle.ms >= KEYLESS_CURSOR_IDLE_MS,
    )
    .sort(
      (left, right) => right.idle.ms - left.idle.ms || left.cursor.number - right.cursor.number,
    )[0]
  if (!idle) return { kind: 'allow' }
  const reference = workflowCursorReference(idle.cursor.number, idle.cursor.project).cli
  return {
    kind: 'refuse',
    cursor: idle.cursor.number,
    message:
      `refusing ${PLATFORM_SLUG} ${input.action}: keyless ${idle.cursor.workflow} cursor ` +
      `${idle.cursor.number} is ${idle.idle.label}; continue it with ${PLATFORM_SLUG} workflow next${reference}, ` +
      `park it with ${PLATFORM_SLUG} workflow await${reference}, or release it with ` +
      `${PLATFORM_SLUG} workflow abandon${reference}`,
  }
}

export async function checkKeylessCursorIdleAdmission(
  action: 'run start' | 'workflow compose' | 'task new',
  input: { now?: number; env?: Record<string, string | undefined> } = {},
): Promise<KeylessCursorIdleAdmission> {
  const caller = classifyCaller(input.env ?? process.env)
  if (caller.kind !== 'harness') return { kind: 'allow' }
  const identity = resolveCallerIdentity(caller, null)
  if (identity.kind !== 'identity') return { kind: 'allow' }
  const rows = await taskFlowReadStore(db()).listOpenStages({ sessionId: identity.session })
  return decideKeylessCursorIdleAdmission({
    action,
    now: input.now ?? Date.now(),
    cursors: rows.map((row) => ({
      number: row.id,
      project: row.project,
      workflow: row.workflow_slug,
      key: row.workflow_key,
      updatedAt: row.updated_at,
      questionNumber: row.question_number,
    })),
  })
}

export async function assertKeylessCursorIdleAdmission(
  action: 'run start' | 'workflow compose' | 'task new',
  input: { now?: number; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  const decision = await checkKeylessCursorIdleAdmission(action, input)
  if (decision.kind === 'refuse') throw new Error(decision.message)
}
