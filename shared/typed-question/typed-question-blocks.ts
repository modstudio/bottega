import { noulProbability } from './client.ts'
import { type TypedQuestionMetricRow, typedQuestionMetrics } from './typed-question-metrics.ts'
import type { TypedQuestionReportBlock } from './typed-question-render.ts'

/** One recorded answer as every concern's store returns it. */
export type TypedQuestionAnswerRow = {
  question_id: string
  question_version: number
  subject_kind: string
  subject_ref: string
  answer_json: string | null
  input_tokens: number | null
  latency_ms: number
  error: string | null
}

/** What a concern knows about one question: how to label a subject, and its current threshold. */
export type TypedQuestionJudgment = {
  label: ((subjectRef: string, subjectKind: string) => boolean | null) | null
  threshold: number | null
}

/** Group answers by question and version and measure each group; the caller supplies the outcomes. */
export function typedQuestionBlocks(
  rows: readonly TypedQuestionAnswerRow[],
  judgment: (questionId: string, questionVersion: number) => TypedQuestionJudgment,
): TypedQuestionReportBlock[] {
  const groups = Map.groupBy(
    rows,
    (row) => `${row.question_id}\0${row.question_version}\0${row.subject_kind}`,
  )
  return [...groups.values()].map((answers) => {
    const first = answers[0]!
    const { label, threshold } = judgment(first.question_id, first.question_version)
    const metricRows: TypedQuestionMetricRow[] = answers.map((answer) => ({
      probability: answer.answer_json === null ? null : noulProbability(answer.answer_json),
      label: label ? label(answer.subject_ref, answer.subject_kind) : null,
      error: answer.error,
      latencyMs: answer.latency_ms,
      inputTokens: answer.input_tokens,
    }))
    const metrics = typedQuestionMetrics(metricRows, threshold)
    return {
      questionId: first.question_id,
      questionVersion: first.question_version,
      subjectKind: first.subject_kind,
      threshold,
      ...metrics,
      labeled: label ? metrics.labeled : null,
      pending: label ? metrics.pending : null,
      baseRate: label ? metrics.baseRate : null,
      auc: label ? metrics.auc : null,
    }
  })
}

/** The `--days` option of every typed-question report, validated once. */
export function typedQuestionDays(option: string | undefined): number | undefined {
  if (option === undefined) return undefined
  const days = Number(option)
  if (!/^\d+$/.test(option) || !Number.isSafeInteger(days) || days < 1)
    throw new Error('--days must be a positive integer')
  return days
}
