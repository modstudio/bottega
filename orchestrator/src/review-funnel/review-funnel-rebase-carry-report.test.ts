import { expect, test } from 'bun:test'
import type { ReviewFunnelFacts, ReviewFunnelVerdict } from './decide-review-funnel.ts'
import {
  type RebaseCarryReportRow,
  summarizeRebaseCarryRows,
} from './review-funnel-rebase-carry-report.ts'

const row = (taskKey: string, lenses: string[]): RebaseCarryReportRow => ({
  recordId: taskKey,
  facts: {
    change: {
      project: 'bottega',
      taskKey,
      branch: taskKey,
      head: `head-${taskKey}`,
      patchId: 'patch',
      pathSet: '[]',
      paths: [],
    },
  } as ReviewFunnelFacts,
  verdict: {
    lenses: lenses.map((lens) => ({ lens, status: 'owed', reason: 'rebase-changed-file' })),
  } as ReviewFunnelVerdict,
})

test('reports old re-owes, exact-hunk carries, and unavailable recomputations separately', () => {
  const report = summarizeRebaseCarryRows(
    [row('DEV-1', ['correctness', 'craft']), row('DEV-2', ['teardown-safety'])],
    ({ recordId }) => {
      if (recordId === 'DEV-2') throw new Error('commit unavailable')
      return { correctness: ['src/a.ts'] }
    },
  )
  expect(report).toMatchObject({ rows: 2, before: 3, after: 1, carried: 1, unavailable: 1 })
  expect(report.entries[0]).toMatchObject({
    after: ['correctness'],
    carried: ['craft'],
    unavailable: null,
  })
  expect(report.entries[1]).toMatchObject({ after: null, unavailable: 'Error: commit unavailable' })
})
