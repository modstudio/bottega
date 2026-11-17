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
    head: 'head-sha',
    patchId: 'patch',
    pathSet: 'paths',
    paths: ['orchestrator/src/example.ts'],
  },
  lenses: [],
  next: { action: 'admit' },
  ...overrides,
})

test('renders an owed lens count with the task-key remedy', () => {
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
    `DEV-1234: 2 review lenses owed → ${PLATFORM_SLUG} review tier DEV-1234`,
  )
})

test('renders one owed lens in the singular', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'DEV-1234-work',
      taskKey: 'DEV-1234',
      verdict: verdict({
        lenses: [{ lens: 'correctness', status: 'owed', reason: 'initial' }],
        next: { action: 'dispatch', lenses: ['correctness'] },
      }),
    }),
  ).toBe(`DEV-1234: 1 review lens owed → ${PLATFORM_SLUG} review tier DEV-1234`)
})

test('omits owed lenses while any lens is running', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'DEV-1234-work',
      taskKey: 'DEV-1234',
      verdict: verdict({
        lenses: [
          { lens: 'correctness', status: 'running', reason: 'running' },
          { lens: 'craft', status: 'owed', reason: 'initial' },
        ],
        next: { action: 'wait' },
      }),
    }),
  ).toBeNull()
})

test('falls back to the branch when there is no task key', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'unkeyed-work',
      taskKey: null,
      verdict: verdict({
        lenses: [{ lens: 'correctness', status: 'owed', reason: 'initial' }],
        next: { action: 'dispatch', lenses: ['correctness'] },
      }),
    }),
  ).toBe(`unkeyed-work: 1 review lens owed → ${PLATFORM_SLUG} review tier unkeyed-work`)
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
    `DEV-1234: architect read owed → ${PLATFORM_SLUG} review read --sha head-sha --note "<what was read and why it lands>"`,
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
    `DEV-1234-work: review verdict unavailable (git timed out while reading the branch) → ${PLATFORM_SLUG} review tier DEV-1234-work`,
  )
})

test('uses the task key for a verdict failure remedy', () => {
  expect(
    stopSummaryReviewVerdictLine({
      branch: 'DEV-1234-work',
      taskKey: 'DEV-1234',
      failure: 'git timed out',
    }),
  ).toBe(
    `DEV-1234: review verdict unavailable (git timed out) → ${PLATFORM_SLUG} review tier DEV-1234`,
  )
})
