// concern: typed-question-commands
/** Presents typed-question measurements. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { typedQuestionDays } from '../../../shared/typed-question/typed-question-blocks.ts'
import { renderTypedQuestionBlock } from '../../../shared/typed-question/typed-question-render.ts'
import { typedQuestionReport } from './typed-question-report.ts'

type Presentation = { log(value: string): void }

export function typedQuestionCommand(
  options: { question?: string; days?: string; json: boolean },
  presentation: Presentation,
): void {
  const days = typedQuestionDays(options.days)
  const report = typedQuestionReport({ question: options.question, days })
  if (!report.length) {
    const filters = [
      options.question ? `question ${options.question}` : null,
      days !== undefined ? `the last ${days} day(s)` : null,
    ].filter(Boolean)
    presentation.log(
      filters.length
        ? `no typed-question answers recorded for ${filters.join(' in ')}; run without the filter to see every recorded question`
        : `no typed-question answers recorded — record them with: ${PLATFORM_SLUG} run start implement`,
    )
    return
  }
  if (options.json) {
    presentation.log(JSON.stringify(report, null, 2))
    return
  }
  for (const block of report) renderTypedQuestionBlock(block, presentation)
}
