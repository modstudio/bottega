import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { RebaseCarryDecision } from '../review/review-post-fix.ts'
import type { ReviewFunnelFacts, ReviewFunnelVerdict } from './decide-review-funnel.ts'
import {
  type RebaseCarryReportRow,
  summarizeRebaseCarryRows,
} from './review-funnel-rebase-carry-report.ts'

const row = (taskKey: string, lenses: string[]): RebaseCarryReportRow => ({
  recordId: taskKey,
  facts: {
    change: {
      project: PLATFORM_NAME,
      taskKey,
      branch: taskKey,
      head: `head-${taskKey}`,
      patchId: 'patch',
      pathSet: '[]',
      paths: [],
    },
  } as unknown as ReviewFunnelFacts,
  verdict: {
    lenses: lenses.map((lens) => ({ lens, status: 'owed', reason: 'rebase-changed-file' })),
  } as ReviewFunnelVerdict,
})

const decision = (...lenses: string[]): RebaseCarryDecision => ({
  fixFiles: [],
  reOwedPathsByLens: Object.fromEntries(lenses.map((lens) => [lens, ['src/a.ts']])),
})

test('reports old re-owes, exact-hunk carries, and unavailable recomputations separately', () => {
  const report = summarizeRebaseCarryRows(
    [row('DEV-1', ['correctness', 'craft']), row('DEV-2', ['teardown-safety'])],
    ({ recordId }) => {
      if (recordId === 'DEV-2') throw new Error('commit unavailable')
      return { before: decision('correctness', 'craft'), after: decision('correctness') }
    },
  )
  expect(report).toMatchObject({ rows: 2, before: 2, after: 1, carried: 1, unavailable: 1 })
  expect(report.entries[0]).toMatchObject({
    before: ['correctness', 'craft'],
    after: ['correctness'],
    carried: ['craft'],
    unavailable: null,
  })
  expect(report.entries[1]).toMatchObject({
    before: null,
    after: null,
    unavailable: 'Error: commit unavailable',
  })
})
