// concern: typed-question-commands
/** Presents typed-question measurements. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type TypedQuestionReportBlock, typedQuestionReport } from './typed-question-report.ts'

type Presentation = { log(value: string): void }

const value = (measurement: number | null, digits = 2): string =>
  measurement === null ? 'none' : measurement.toFixed(digits)

function render(block: TypedQuestionReportBlock, presentation: Presentation): void {
  const lines: [string, string][] = [
    ['threshold', value(block.threshold)],
    ['recorded', String(block.recorded)],
    ['answered', String(block.answered)],
    ['errors', JSON.stringify(block.errors)],
    ['labeled', block.labeled === null ? 'none' : String(block.labeled)],
    ['pending', block.pending === null ? 'none' : String(block.pending)],
    ['baseRate', value(block.baseRate)],
    ['auc', value(block.auc)],
    ['precision', value(block.precision)],
    ['recall', value(block.recall)],
    ['warnedRate', value(block.warnedRate)],
    ['latencyP50Ms', String(block.latencyP50Ms)],
    ['latencyP95Ms', String(block.latencyP95Ms)],
    ['inputTokens', String(block.inputTokens)],
    ['costUsd', value(block.costUsd, 6)],
  ]
  presentation.log(`\n${block.questionId} v${block.questionVersion}`)
  for (const [name, shown] of lines) presentation.log(`  ${name.padEnd(16)}${shown}`)
}

export function typedQuestionCommand(
  options: { question?: string; days?: string; json: boolean },
  presentation: Presentation,
): void {
  let days: number | undefined
  if (options.days !== undefined) {
    days = Number(options.days)
    if (!/^\d+$/.test(options.days) || !Number.isSafeInteger(days) || days < 1)
      throw new Error('--days must be a positive integer')
  }
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
  for (const block of report) render(block, presentation)
}
