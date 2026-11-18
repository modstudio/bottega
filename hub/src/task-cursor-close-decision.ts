// concern: task workflow cursor close decision
/** Selects task cursors to abandon or refuses while selected cursors have live work. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { OpenWorkflowCursor } from '../../shared/orch-contract.ts'

export type OpenTaskWorkflowCursor = OpenWorkflowCursor

export function decideTaskCursorClose(input: {
  key: string
  cursors: OpenTaskWorkflowCursor[]
  callingSession: string | null
}):
  | { action: 'abandon'; cursors: OpenTaskWorkflowCursor[] }
  | { action: 'refuse'; reason: string } {
  const cursors = input.cursors.filter(
    (cursor) =>
      cursor.workflow_key?.toUpperCase() === input.key.toUpperCase() &&
      (input.callingSession === null || cursor.session_id !== input.callingSession),
  )
  const live = cursors.flatMap((cursor) => cursor.live_runs.map((run) => ({ cursor, run })))
  if (!live.length) return { action: 'abandon', cursors }
  const details = live
    .map(
      ({ cursor, run }) =>
        `cursor ${cursor.id} has live run ${run.number} [${run.record_id}]; clear it with: ${PLATFORM_SLUG} run stop ${run.number}`,
    )
    .join('\n')
  return {
    action: 'refuse',
    reason: `refusing to close task ${input.key} while its cursor has live work:\n${details}`,
  }
}
