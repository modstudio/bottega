// concern: session close-out worked report
/** Records and reports historical task work without blocking the close-out verdict. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordSessionWorked, sessionWorkedTaskKeys } from '../doc/context-worked-adapter.ts'
import type { SessionErrorLine, SessionWarningLine } from './session-close-out-report.ts'

type WorkedCloseOutReport = {
  warnings: SessionWarningLine[]
  errors: SessionErrorLine[]
}

export async function appendWorkedCloseOutReport(input: {
  report: WorkedCloseOutReport
  session: string
  database: Database
  writeWorked: boolean
}): Promise<void> {
  if (!input.writeWorked) return
  let workedKeys: string[]
  try {
    workedKeys = await sessionWorkedTaskKeys(input.session, input.database)
  } catch (cause) {
    input.report.warnings.push({
      item: 'close-out worked report',
      detail: cause instanceof Error ? cause.message : String(cause),
      cleanup: `${PLATFORM_SLUG} session close-out --session ${input.session}`,
    })
    return
  }
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
