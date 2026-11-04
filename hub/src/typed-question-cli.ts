// concern: typed-question-cli
/** Presents hub-owned typed-question measurements. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { typedQuestionDays } from '../../shared/typed-question/typed-question-blocks.ts'
import { renderTypedQuestionBlock } from '../../shared/typed-question/typed-question-render.ts'
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
        : `no typed-question answers recorded — they are recorded when ${PLATFORM_SLUG} note new is run with TYPESAFE_KEY set`,
    )
    return
  }
  if (options.json) presentation.log(JSON.stringify(report, null, 2))
  else for (const block of report) renderTypedQuestionBlock(block, presentation)
}
