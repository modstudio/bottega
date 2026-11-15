import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ReviewFunnelVerdict } from '../review-funnel/decide-review-funnel.ts'
import { stopSummaryReviewVerdictLine } from './stop-summary-review-verdict.ts'

const verdict = (
  overrides: Partial<Pick<ReviewFunnelVerdict, 'change' | 'lenses' | 'next'>> = {},
): Pick<ReviewFunnelVerdict, 'change' | 'lenses' | 'next'> => ({
  change: {
    project: PLATFORM_NAME,
    branch: 'DEV-1234-work',
    taskKey: 'DEV-1234',
    base: 'base',
    head: 'head-sha',
    patchId: 'patch',
    pathSet: 'paths',
    paths: ['orchestrator/src/example.ts'],
  },
  lenses: [],
  next: { action: 'admit' },
  ...overrides,
})

test('renders every owed lens on one branch line', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'DEV-1234-work',
      taskKey: 'DEV-1234',
      verdict: verdict({
        lenses: [
          { lens: 'correctness', status: 'owed', reason: 'initial' },
          { lens: 'craft', status: 'owed', reason: 'initial' },
        ],
        next: { action: 'dispatch', lenses: ['correctness', 'craft'] },
      }),
    }),
  ).toBe(
    `DEV-1234 review: lens correctness, craft owed → ${PLATFORM_SLUG} review tier DEV-1234-work`,
  )
})

test('omits a satisfied branch', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'DEV-1234-work',
      taskKey: 'DEV-1234',
      verdict: verdict({
        lenses: [{ lens: 'correctness', status: 'satisfied', reason: 'satisfied' }],
      }),
    }),
  ).toBeNull()
})

test('tier zero architect read names the read command', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'DEV-1234-work',
      taskKey: 'DEV-1234',
      verdict: verdict({ next: { action: 'record-read' } }),
    }),
  ).toBe(
    `DEV-1234 review: architect read owed → ${PLATFORM_SLUG} review read --sha head-sha --note "<what was read and why it lands>"`,
  )
})

test('renders a one-line branch failure with the tier remedy', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'DEV-1234-work',
      taskKey: null,
      failure: 'git timed out\nwhile reading the branch',
    }),
  ).toBe(
    `DEV-1234-work review: verdict unavailable (git timed out while reading the branch) → ${PLATFORM_SLUG} review tier DEV-1234-work`,
  )
})
