import type { TypedQuestionMetrics } from './typed-question-metrics.ts'

export type TypedQuestionReportBlock = Omit<TypedQuestionMetrics, 'labeled' | 'pending'> & {
  questionId: string
  questionVersion: number
  subjectKind: string
  model: string | null
  threshold: number | null
  labeled: number | null
  pending: number | null
}

type Presentation = { log(value: string): void }

const value = (measurement: number | null, digits = 2): string =>
  measurement === null ? 'none' : measurement.toFixed(digits)

export function renderTypedQuestionBlock(
  block: TypedQuestionReportBlock,
  presentation: Presentation,
): void {
  const lines: [string, string][] = [
    ['threshold', value(block.threshold)],
    ['recorded', String(block.recorded)],
    ['answered', String(block.answered)],
    ['errors', JSON.stringify(block.errors)],
    ['labeled', block.labeled === null ? 'none' : String(block.labeled)],
    ['pending', block.pending === null ? 'none' : String(block.pending)],
    ['baseRate', value(block.baseRate)],
    ['auc', value(block.auc)],
    ['brier', value(block.brier)],
    ['logLoss', value(block.logLoss)],
    ['ece', value(block.ece)],
    ['precision', value(block.precision)],
    ['recall', value(block.recall)],
    ['warnedRate', value(block.warnedRate)],
    ['latencyP50Ms', String(block.latencyP50Ms)],
    ['latencyP95Ms', String(block.latencyP95Ms)],
    ['inputTokens', String(block.inputTokens)],
    ['costUsd', value(block.costUsd, 6)],
  ]
  presentation.log(
    `\n${block.questionId} v${block.questionVersion} (${block.subjectKind}) ${block.model ?? 'model none'}`,
  )
  for (const [name, shown] of lines) presentation.log(`  ${name.padEnd(16)}${shown}`)
}
