import { expect, test } from 'bun:test'
import { type ReviewRecordRow, reviewRecordFindings } from './review-record-findings.ts'

test('exports accepted, modified, rejected and skipped findings across two lenses', () => {
  const rows: ReviewRecordRow[] = [
    {
      lens: 'correctness',
      run: 41,
      disposition: 'accepted',
      category: null,
      severity: 'high',
      location: 'src/a.ts:3',
    },
    {
      lens: 'correctness',
      run: 41,
      disposition: 'modified',
      category: null,
      severity: 'medium',
      location: 'src/b.ts:5',
    },
    {
      lens: 'craft',
      run: 42,
      disposition: 'rejected',
      category: 'below-bar',
      severity: null,
      location: 'src/c.ts:8',
    },
    {
      lens: 'craft',
      run: 42,
      disposition: 'skipped',
      category: null,
      severity: null,
      location: 'src/d.ts:13',
    },
  ]

  expect(reviewRecordFindings(rows)).toEqual({
    lenses: ['correctness', 'craft'],
    findings: [
      {
        lens: 'correctness',
        verdict: 'accept',
        severity: 'high',
        location: 'src/a.ts:3',
        run: 41,
      },
      {
        lens: 'correctness',
        verdict: 'modify',
        severity: 'medium',
        location: 'src/b.ts:5',
        run: 41,
      },
      {
        lens: 'craft',
        verdict: 'reject',
        category: 'below-bar',
        location: 'src/c.ts:8',
        run: 42,
      },
    ],
    skipped: 1,
  })
})
