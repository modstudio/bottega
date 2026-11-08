// concern: jev-worker-question-report
/** Measures Jev advice against later architect rulings from plain stored values. */

import { typedQuestionCalibration } from '../../../shared/typed-question/typed-question-metrics.ts'
import { type JevQuestionKind, pickProbability } from '../ask/jev-routing.ts'

export type JevWorkerQuestionRow = {
  kind: JevQuestionKind
  jev_model: string | null
  jev_pick: string
  jev_probabilities: string | null
  jev_agreed: number | null
  jev_question_version: number | null
  jev_fits: number | null
  jev_order_flipped: number | null
}

type JevAgreementBand = {
  range: string
  n: number
  agreementRate: number | null
}

export type JevWorkerQuestionMetrics = {
  kind: JevWorkerQuestionRow['kind'] | 'all'
  model: string | null
  version: number | null
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
  orderFlipped: number
  fitAtOrAbove: { ruled: number; agreementRate: number | null }
  fitBelow: { ruled: number; agreementRate: number | null }
}

const BAND_LIMITS = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1] as const
const LEGACY_JEV_QUESTION_VERSION = 1

type MeasuredRow = JevWorkerQuestionRow & { probability: number | null }

function storedPickProbability(row: JevWorkerQuestionRow): number | null {
  try {
    const pick = JSON.parse(row.jev_pick) as unknown
    const probabilities = JSON.parse(row.jev_probabilities ?? '') as unknown
    return pickProbability(row.kind, pick, probabilities)
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
  version: number | null,
  fitThreshold: number,
): JevWorkerQuestionMetrics {
  const ruled = rows.filter((row) => row.jev_agreed !== null)
  const readable = ruled.filter(
    (row): row is MeasuredRow & { probability: number } => row.probability !== null,
  )
  const agreed = ruled.filter((row) => row.jev_agreed === 1).length
  const thresholdRows = readable.filter((row) => row.probability >= threshold)
  const fitSplit = (atOrAbove: boolean) => {
    const members = ruled.filter(
      (row) =>
        row.jev_fits !== null &&
        (atOrAbove ? row.jev_fits >= fitThreshold : row.jev_fits < fitThreshold),
    )
    const agreed = members.filter((row) => row.jev_agreed === 1).length
    return { ruled: members.length, agreementRate: members.length ? agreed / members.length : null }
  }
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
    version,
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
    brier: typedQuestionCalibration(
      readable.map((row) => ({ probability: row.probability, label: row.jev_agreed === 1 })),
    ).brier,
    orderFlipped: rows.filter((row) => row.jev_order_flipped === 1).length,
    fitAtOrAbove: fitSplit(true),
    fitBelow: fitSplit(false),
  }
}

/** Returns the aggregate first, followed by each kind-and-model cohort. */
export function jevWorkerQuestionMetrics(
  rows: readonly JevWorkerQuestionRow[],
  threshold: number,
  fitThreshold: number,
): JevWorkerQuestionMetrics[] {
  if (!rows.length) return []
  const measured = rows.map((row) => ({ ...row, probability: storedPickProbability(row) }))
  const groups = Map.groupBy(measured, (row) =>
    JSON.stringify([
      row.kind,
      row.jev_model,
      row.jev_question_version ?? LEGACY_JEV_QUESTION_VERSION,
    ]),
  )
  return [
    measureGroup(measured, threshold, 'all', null, null, fitThreshold),
    ...[...groups.values()].map((group) =>
      measureGroup(
        group,
        threshold,
        group[0]!.kind,
        group[0]!.jev_model,
        group[0]!.jev_question_version ?? LEGACY_JEV_QUESTION_VERSION,
        fitThreshold,
      ),
    ),
  ]
}
