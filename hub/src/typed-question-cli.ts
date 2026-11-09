// concern: typed-question-cli
/** Presents hub-owned typed-question measurements. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { typedQuestionDays } from '../../shared/typed-question/typed-question-blocks.ts'
import { renderTypedQuestionBlock } from '../../shared/typed-question/typed-question-render.ts'
import { noteDuplicateBacktest } from './note-duplicate-backtest.ts'
import { hubTypedQuestionReport } from './typed-question-report.ts'

type Presentation = { log(value: string): void }

export function hubTypedQuestionCommand(
  options: { days?: string; json: boolean },
  presentation: Presentation,
): void {
  const days = typedQuestionDays(options.days)
  const report = hubTypedQuestionReport({ days })
  if (!report.length) {
    presentation.log(
      days !== undefined
        ? `no typed-question answers recorded for the last ${days} day(s); run without the filter to see every recorded question`
        : `no typed-question answers recorded — they are recorded when ${PLATFORM_SLUG} note new is run after ${PLATFORM_SLUG} credential set typesafe/api-key`,
    )
    return
  }
  if (options.json) presentation.log(JSON.stringify(report, null, 2))
  else for (const block of report) renderTypedQuestionBlock(block, presentation)
}

export async function hubTypedQuestionBacktestCommand(
  options: { version: string; json: boolean },
  presentation: Presentation,
): Promise<void> {
  const version = Number(options.version)
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('--version must be a positive integer')
  const report = await noteDuplicateBacktest(version)
  if (options.json) return presentation.log(JSON.stringify(report, null, 2))
  presentation.log(
    `readable ${report.readable}; unreadable ${report.unreadable}; unanswered ${report.unanswered}`,
  )
  presentation.log(`label sources ${JSON.stringify(report.labelSources)}`)
  presentation.log('tuning threshold sweep')
  for (const row of report.sweep)
    presentation.log(
      `  ${row.threshold.toFixed(2)} precision ${row.precision?.toFixed(2) ?? 'none'} recall ${row.recall?.toFixed(2) ?? 'none'} warnedRate ${row.warnedRate?.toFixed(2) ?? 'none'}`,
    )
  presentation.log(
    `held out at threshold ${report.threshold.toFixed(2)}: precision ${report.heldOut.precision?.toFixed(2) ?? 'none'}; recall ${report.heldOut.recall?.toFixed(2) ?? 'none'}; warnedRate ${report.heldOut.warnedRate?.toFixed(2) ?? 'none'}`,
  )
}
