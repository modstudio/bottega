// concern: typed-question-cli
/** Presents hub-owned typed-question measurements. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { renderTypedQuestionBlock } from '../../shared/typed-question/typed-question-render.ts'
import { hubTypedQuestionReport } from './typed-question-report.ts'

type Presentation = { log(value: string): void }

export function hubTypedQuestionCommand(
  options: { days?: string; json: boolean },
  presentation: Presentation,
): void {
  let days: number | undefined
  if (options.days !== undefined) {
    days = Number(options.days)
    if (!/^\d+$/.test(options.days) || !Number.isSafeInteger(days) || days < 1)
      throw new Error('--days must be a positive integer')
  }
  const report = hubTypedQuestionReport({ days })
  if (!report.length) {
    presentation.log(
      days !== undefined
        ? `no typed-question answers recorded for the last ${days} day(s); run without the filter to see every recorded question`
        : `no typed-question answers recorded — record them with: ${PLATFORM_SLUG} note new`,
    )
    return
  }
  if (options.json) presentation.log(JSON.stringify(report, null, 2))
  else for (const block of report) renderTypedQuestionBlock(block, presentation)
}
