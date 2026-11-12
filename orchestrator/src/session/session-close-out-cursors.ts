// concern: session close-out cursors
/** Releases idle explores and reports every session cursor that still needs a successor. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { TaskFlowOpenSessionStageRow as OpenCursor } from '../workflow/task-flow-store.ts'
import { closeExploreForLifecycle } from '../workflow/workflow-explore-lifecycle-close.ts'
import { classifySessionCursor } from './session-close-out-decision.ts'
import type { SessionErrorLine, SessionProcessLine } from './session-close-out-report.ts'

function reportRemainingCursor(
  cursor: OpenCursor,
  report: { parked: string[]; process: SessionProcessLine[] },
): void {
  const disposition = classifySessionCursor({
    state: cursor.state,
    hasOpenQuestion: cursor.open_question_record_id !== null,
  })
  if (disposition === 'parked') {
    report.parked.push(
      `workflow cursor ${cursor.number}: awaiting recorded question ${cursor.open_question_record_id}`,
    )
    return
  }
  const next = `${PLATFORM_SLUG} workflow next ${cursor.workflow_slug} --cursor ${cursor.number}`
  const abandon = `${PLATFORM_SLUG} workflow abandon ${cursor.workflow_slug} --cursor ${cursor.number} --reason "<why>"`
  report.process.push({
    item: `workflow cursor ${cursor.number}`,
    reason: `cursor is ${cursor.state}`,
    evidence: cursor.record_id,
    remedy: `${next}, or ${abandon}`,
  })
}

export async function releaseSessionCursors(input: {
  session: string
  dryRun: boolean
  cursors: readonly OpenCursor[]
  database: Database
  report: {
    mechanical: string[]
    parked: string[]
    process: SessionProcessLine[]
    errors: SessionErrorLine[]
  }
}): Promise<void> {
  for (const cursor of input.cursors) {
    if (cursor.workflow_slug === 'explore' && !cursor.open_question_record_id) {
      const label = `workflow cursor ${cursor.number} (explore) as answered`
      if (input.dryRun) {
        input.report.mechanical.push(`would close ${label}`)
        continue
      }
      try {
        await closeExploreForLifecycle(cursor.record_id, 'answered', input.database)
        input.report.mechanical.push(`closed ${label}`)
        continue
      } catch (cause) {
        input.report.errors.push({
          item: `workflow cursor ${cursor.number}`,
          detail: cause instanceof Error ? cause.message : String(cause),
          retry: `${PLATFORM_SLUG} session close-out --session ${input.session}`,
        })
      }
    }
    reportRemainingCursor(cursor, input.report)
  }
}
