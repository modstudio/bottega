// concern: jev-worker-question-report
/** Measures Jev advice against later architect rulings from plain stored values. */

export type JevWorkerQuestionRow = {
  kind: 'choice' | 'yesno' | 'score'
  jev_model: string | null
  jev_pick: string
  jev_probabilities: string | null
  jev_agreed: number | null
}

type JevAgreementBand = {
  range: string
  n: number
  agreementRate: number | null
}

export type JevWorkerQuestionMetrics = {
  kind: JevWorkerQuestionRow['kind'] | 'all'
  model: string | null
  advised: number
  ruledByArchitect: number
  agreed: number
  agreementRate: number | null
  unreadable: number
  bands: JevAgreementBand[]
  threshold: number
  coverage: number | null
  agreementAtThreshold: number | null
  brier: number | null
}

const BAND_LIMITS = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1] as const

type MeasuredRow = JevWorkerQuestionRow & { probability: number | null }

function finiteProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function probabilityKey(row: JevWorkerQuestionRow, pick: unknown): string | null {
  if (row.kind === 'yesno') return typeof pick === 'boolean' ? (pick ? 'yes' : 'no') : null
  if (row.kind === 'choice') return typeof pick === 'string' ? pick : null
  return typeof pick === 'number' && Number.isInteger(pick) ? String(pick) : null
}

function pickProbability(row: JevWorkerQuestionRow): number | null {
  try {
    const pick = JSON.parse(row.jev_pick) as unknown
    const probabilities = JSON.parse(row.jev_probabilities ?? '') as unknown
    if (!probabilities || typeof probabilities !== 'object') return null
    const key = probabilityKey(row, pick)
    const probability = key === null ? null : (probabilities as Record<string, unknown>)[key]
    return finiteProbability(probability) ? probability : null
  } catch {
    return null
  }
}

function bandIndex(probability: number): number {
  if (probability === 1) return BAND_LIMITS.length - 2
  return BAND_LIMITS.findIndex(
    (lower, index) =>
      index < BAND_LIMITS.length - 1 &&
      probability >= lower &&
      probability < BAND_LIMITS[index + 1]!,
  )
}

function measureGroup(
  rows: readonly MeasuredRow[],
  threshold: number,
  kind: JevWorkerQuestionMetrics['kind'],
  model: string | null,
): JevWorkerQuestionMetrics {
  const ruled = rows.filter((row) => row.jev_agreed !== null)
  const readable = ruled.filter(
    (row): row is MeasuredRow & { probability: number } => row.probability !== null,
  )
  const agreed = ruled.filter((row) => row.jev_agreed === 1).length
  const thresholdRows = readable.filter((row) => row.probability >= threshold)
  const bands = BAND_LIMITS.slice(0, -1).map((lower, index) => {
    const upper = BAND_LIMITS[index + 1]!
    const members = readable.filter((row) => bandIndex(row.probability) === index)
    const bandAgreed = members.filter((row) => row.jev_agreed === 1).length
    return {
      range: index === BAND_LIMITS.length - 2 ? `[${lower},${upper}]` : `[${lower},${upper})`,
      n: members.length,
      agreementRate: members.length ? bandAgreed / members.length : null,
    }
  })
  return {
    kind,
    model,
    advised: rows.length,
    ruledByArchitect: ruled.length,
    agreed,
    agreementRate: ruled.length ? agreed / ruled.length : null,
    unreadable: rows.filter((row) => row.probability === null).length,
    bands,
    threshold,
    coverage: ruled.length ? thresholdRows.length / ruled.length : null,
    agreementAtThreshold: thresholdRows.length
      ? thresholdRows.filter((row) => row.jev_agreed === 1).length / thresholdRows.length
      : null,
    brier: readable.length
      ? readable.reduce(
          (total, row) => total + (row.probability - (row.jev_agreed === 1 ? 1 : 0)) ** 2,
          0,
        ) / readable.length
      : null,
  }
}

/** Returns the aggregate first, followed by each kind-and-model cohort. */
export function jevWorkerQuestionMetrics(
  rows: readonly JevWorkerQuestionRow[],
  threshold: number,
): JevWorkerQuestionMetrics[] {
  if (!rows.length) return []
  const measured = rows.map((row) => ({ ...row, probability: pickProbability(row) }))
  const groups = Map.groupBy(measured, (row) => JSON.stringify([row.kind, row.jev_model]))
  return [
    measureGroup(measured, threshold, 'all', null),
    ...[...groups.values()].map((group) =>
      measureGroup(group, threshold, group[0]!.kind, group[0]!.jev_model),
    ),
  ]
}
