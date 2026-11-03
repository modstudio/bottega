// concern: typed-question-commands
/** Presents typed-question measurements. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type TypedQuestionReportBlock, typedQuestionReport } from './typed-question-report.ts'

type Presentation = { log(value: string): void }

const value = (measurement: number | null): string =>
  measurement === null ? 'none' : String(measurement)

function render(block: TypedQuestionReportBlock, presentation: Presentation): void {
  presentation.log(`\n${block.questionId} v${block.questionVersion}`)
  presentation.log(`  threshold       ${value(block.threshold)}`)
  presentation.log(`  answered        ${block.answered}`)
  presentation.log(`  errors          ${JSON.stringify(block.errors)}`)
  presentation.log(`  labelled        ${value(block.labelled)}`)
  presentation.log(`  pending         ${value(block.pending)}`)
  presentation.log(`  baseRate        ${value(block.baseRate)}`)
  presentation.log(`  auc             ${value(block.auc)}`)
  presentation.log(`  precision       ${value(block.precision)}`)
  presentation.log(`  recall          ${value(block.recall)}`)
  presentation.log(`  warnedRate      ${value(block.warnedRate)}`)
  presentation.log(`  latencyP50Ms    ${block.latencyP50Ms}`)
  presentation.log(`  latencyP95Ms    ${block.latencyP95Ms}`)
  presentation.log(`  inputTokens     ${block.inputTokens}`)
  presentation.log(`  costUsd         ${block.costUsd}`)
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
    presentation.log(
      `no typed-question answers recorded — record them with: ${PLATFORM_SLUG} run start implement`,
    )
    return
  }
  if (options.json) {
    presentation.log(JSON.stringify(report, null, 2))
    return
  }
  for (const block of report) render(block, presentation)
}
