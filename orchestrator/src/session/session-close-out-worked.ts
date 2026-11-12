// concern: session close-out worked report
/** Records and reports historical task work without blocking the close-out verdict. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordSessionWorked, sessionWorkedTaskKeys } from '../doc/context-worked-adapter.ts'
import {
  type TaskNextActionOutcome,
  taskNextActionOutcomes,
} from './session-close-out-next-actions.ts'
import type { SessionErrorLine, SessionWarningLine } from './session-close-out-report.ts'

type WorkedCloseOutReport = {
  nextActionOutcomes: TaskNextActionOutcome[]
  warnings: SessionWarningLine[]
  errors: SessionErrorLine[]
}

function appendNextActionWarnings(report: WorkedCloseOutReport): void {
  for (const outcome of report.nextActionOutcomes) {
    if (outcome.status === 'present' || outcome.status === 'missing') continue
    report.warnings.push({
      item: `close-out task ${outcome.key}`,
      detail: outcome.detail,
      cleanup: outcome.remedy,
    })
  }
}

export async function appendWorkedCloseOutReport(input: {
  report: WorkedCloseOutReport
  session: string
  database: Database
  reportNextActions: boolean
  writeWorked: boolean
}): Promise<void> {
  if (!input.reportNextActions && !input.writeWorked) return
  let workedKeys: string[]
  try {
    workedKeys = await sessionWorkedTaskKeys(input.session, input.database)
    if (input.reportNextActions) {
      input.report.nextActionOutcomes = await taskNextActionOutcomes(workedKeys, input.database)
      appendNextActionWarnings(input.report)
    }
  } catch (cause) {
    input.report.warnings.push({
      item: 'close-out worked report',
      detail: cause instanceof Error ? cause.message : String(cause),
      cleanup: `${PLATFORM_SLUG} session close-out --session ${input.session}`,
    })
    return
  }
  if (!input.writeWorked) return
  try {
    await recordSessionWorked(input.session, workedKeys, 'close-out')
  } catch (cause) {
    input.report.errors.push({
      item: `context session:${input.session}/worked (fact)`,
      detail: cause instanceof Error ? cause.message : String(cause),
      retry: `${PLATFORM_SLUG} session close-out --session ${input.session} --resume`,
    })
  }
}
