// concern: cost-per-useful-result efficiency report
/** Shapes review yield for adjacent efficiency windows and loads its pricing context. */

import type { Database } from 'bun:sqlite'
import { loadSubscriptionCostContext } from '../run/run-subscription-prices.ts'
import { type ReviewYieldReport, reviewYield } from './review-yield.ts'

export type ReviewYieldEfficiencyWindow = { start: string; end: string }

type UsefulResultRow = Pick<
  ReviewYieldReport['lenses'][number],
  'key' | 'runs' | 'hits' | 'costPerHit' | 'pricedHits' | 'minutesPerHit' | 'timedHits'
>

const usefulRows = (rows: ReviewYieldReport['lenses']): UsefulResultRow[] =>
  rows
    .map(({ key, runs, hits, costPerHit, pricedHits, minutesPerHit, timedHits }) => ({
      key,
      runs,
      hits,
      costPerHit,
      pricedHits,
      minutesPerHit,
      timedHits,
    }))
    .sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key))

const reviewYieldEfficiencyWindow = (
  window: ReviewYieldEfficiencyWindow,
  report: ReviewYieldReport,
) => ({
  window,
  completedReviews: report.lenses.some((row) => row.reviews.completed > 0),
  lenses: usefulRows(report.lenses),
  agents: usefulRows(report.agents),
})

export async function loadReviewYieldEfficiencyReport(
  database: Database,
  windows: {
    currentWindow: ReviewYieldEfficiencyWindow
    previousWindow: ReviewYieldEfficiencyWindow
  },
  project?: string,
) {
  const subscriptionCost = await loadSubscriptionCostContext()
  const load = (window: ReviewYieldEfficiencyWindow) =>
    reviewYieldEfficiencyWindow(
      window,
      reviewYield({ project, since: window.start, until: window.end }, database, subscriptionCost),
    )
  return {
    current: load(windows.currentWindow),
    previous: load(windows.previousWindow),
  }
}
