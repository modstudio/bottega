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
  recorded: number
  answered: number
  errors: Record<string, number>
  labeled: number
  pending: number
  baseRate: number | null
  auc: number | null
  brier: number | null
  logLoss: number | null
  ece: number | null
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

export function typedQuestionCalibration(
  rows: readonly { probability: number; label: boolean }[],
): {
  brier: number | null
  logLoss: number | null
  ece: number | null
} {
  if (!rows.length) return { brier: null, logLoss: null, ece: null }
  let squaredError = 0
  let logLoss = 0
  const bins = Array.from({ length: 10 }, () => ({ count: 0, probability: 0, labels: 0 }))
  for (const row of rows) {
    const label = row.label ? 1 : 0
    squaredError += (row.probability - label) ** 2
    const clamped = Math.max(1e-6, Math.min(1 - 1e-6, row.probability))
    logLoss -= label * Math.log(clamped) + (1 - label) * Math.log(1 - clamped)
    const bin = bins[Math.min(9, Math.floor(row.probability * 10))]!
    bin.count += 1
    bin.probability += row.probability
    bin.labels += label
  }
  const ece = bins.reduce(
    (total, bin) =>
      bin.count === 0
        ? total
        : total +
          (bin.count / rows.length) *
            Math.abs(bin.probability / bin.count - bin.labels / bin.count),
    0,
  )
  return {
    brier: squaredError / rows.length,
    logLoss: logLoss / rows.length,
    ece,
  }
}

export function typedQuestionMetrics(
  rows: readonly TypedQuestionMetricRow[],
  threshold: number | null,
): TypedQuestionMetrics {
  const answered = rows.filter(
    (row): row is TypedQuestionMetricRow & { probability: number } =>
      row.error === null && row.probability !== null,
  )
  const labeled = answered.filter(
    (row): row is typeof row & { label: boolean } => row.label !== null,
  )
  const positives = labeled.filter((row) => row.label)
  const warned = threshold === null ? null : answered.filter((row) => row.probability >= threshold)
  const warnedLabeled =
    threshold === null ? null : labeled.filter((row) => row.probability >= threshold)
  const truePositives = warnedLabeled?.filter((row) => row.label).length ?? 0
  const inputTokens = rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0)
  const errors: Record<string, number> = {}
  for (const row of rows) {
    if (row.error !== null) errors[row.error] = (errors[row.error] ?? 0) + 1
  }
  const calibrationMetrics = typedQuestionCalibration(labeled)
  return {
    recorded: rows.length,
    answered: answered.length,
    errors,
    labeled: labeled.length,
    pending: answered.length - labeled.length,
    baseRate: labeled.length ? positives.length / labeled.length : null,
    auc: auc(labeled),
    ...calibrationMetrics,
    precision: warnedLabeled?.length ? truePositives / warnedLabeled.length : null,
    recall: warnedLabeled && positives.length ? truePositives / positives.length : null,
    warnedRate: warned && answered.length ? warned.length / answered.length : null,
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
