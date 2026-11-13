import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  classifyStopSummaryReviews,
  type StopSummaryReviewLensRow,
} from './stop-summary-reviews.ts'

const lens = (
  review: number,
  status: string,
  overrides: Partial<StopSummaryReviewLensRow> = {},
): StopSummaryReviewLensRow => ({
  review_record_id: `review-${review}`,
  number: review,
  completed_at: null,
  outdated_at: null,
  run_status: status,
  finished_at: '2026-11-13T10:00:00.000Z',
  open_findings: 2,
  ...overrides,
})

test('review rounds move only for live lenses and terminal untriaged rounds become owed', () => {
  const result = classifyStopSummaryReviews([
    lens(7, 'ok'),
    lens(7, 'failed', { finished_at: '2026-11-13T11:00:00.000Z' }),
    lens(8, 'running'),
    lens(9, 'stopped', { outdated_at: '2026-11-13T11:30:00.000Z' }),
    lens(10, 'ok', { completed_at: '2026-11-13T11:30:00.000Z' }),
  ])

  expect(result.incompleteReviews).toBe(1)
  expect(result.owedItems).toEqual([
    {
      label: 'review 7 untriaged (2 findings open)',
      command: `${PLATFORM_SLUG} review show 7`,
      owedAt: '2026-11-13T11:00:00.000Z',
    },
  ])
})
