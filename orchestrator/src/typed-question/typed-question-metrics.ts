// concern: typed-question-metrics
/** Computes typed-question measurements from plain values. */

const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042

export type TypedQuestionMetricRow = {
  probability: number | null
  label: boolean | null
  error: string | null
  latencyMs: number
  inputTokens: number | null
}

export type TypedQuestionMetrics = {
  answered: number
  errors: Record<string, number>
  labelled: number
  pending: number
  baseRate: number | null
  auc: number | null
  precision: number | null
  recall: number | null
  warnedRate: number | null
  latencyP50Ms: number
  latencyP95Ms: number
  inputTokens: number
  costUsd: number
}

function nearestRank(values: readonly number[], proportion: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)]!
}

function auc(rows: readonly { probability: number; label: boolean }[]): number | null {
  const positive = rows.filter((row) => row.label)
  const negative = rows.filter((row) => !row.label)
  if (!positive.length || !negative.length) return null
  let wins = 0
  for (const yes of positive) {
    for (const no of negative) {
      if (yes.probability > no.probability) wins += 1
      else if (yes.probability === no.probability) wins += 0.5
    }
  }
  return wins / (positive.length * negative.length)
}

export function typedQuestionMetrics(
  rows: readonly TypedQuestionMetricRow[],
  threshold: number,
): TypedQuestionMetrics {
  const answered = rows.filter(
    (row): row is TypedQuestionMetricRow & { probability: number } =>
      row.error === null && row.probability !== null,
  )
  const labelled = answered.filter(
    (row): row is typeof row & { label: boolean } => row.label !== null,
  )
  const positives = labelled.filter((row) => row.label)
  const warned = answered.filter((row) => row.probability >= threshold)
  const warnedLabelled = labelled.filter((row) => row.probability >= threshold)
  const truePositives = warnedLabelled.filter((row) => row.label).length
  const inputTokens = rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0)
  const errors: Record<string, number> = {}
  for (const row of rows) {
    if (row.error !== null) errors[row.error] = (errors[row.error] ?? 0) + 1
  }
  return {
    answered: answered.length,
    errors,
    labelled: labelled.length,
    pending: answered.length - labelled.length,
    baseRate: labelled.length ? positives.length / labelled.length : null,
    auc: auc(labelled),
    precision: warnedLabelled.length ? truePositives / warnedLabelled.length : null,
    recall: positives.length ? truePositives / positives.length : null,
    warnedRate: answered.length ? warned.length / answered.length : null,
    latencyP50Ms: nearestRank(
      rows.map((row) => row.latencyMs),
      0.5,
    ),
    latencyP95Ms: nearestRank(
      rows.map((row) => row.latencyMs),
      0.95,
    ),
    inputTokens,
    costUsd: (inputTokens * JEV_USD_PER_MILLION_INPUT_TOKENS) / 1_000_000,
  }
}
