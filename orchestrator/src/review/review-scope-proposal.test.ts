import { describe, expect, test } from 'bun:test'
import { proposeReviewScopes, type ReviewScopeProject } from './review-scope-proposal.ts'

const finding = { disposition: 'accepted', triaged_severity: 'medium' }

function project(runs: ReviewScopeProject['runs']): ReviewScopeProject {
  return {
    project: 'fixture',
    topLevelDirectories: ['docs', 'src', 'test'],
    review: {
      lenses: [{ lens: 'correctness' }, { lens: 'test-quality', paths: ['**/*.test.ts'] }],
    },
    runs,
  }
}

describe('review scope proposal', () => {
  test('proposes the one directory containing all accepted medium+ findings', () => {
    const report = proposeReviewScopes([
      project([
        {
          id: 'one',
          lens: 'correctness',
          paths: ['src/a.ts'],
          complete: true,
          findings: [finding],
        },
        {
          id: 'two',
          lens: 'correctness',
          paths: ['src/b.ts'],
          complete: true,
          findings: [finding],
        },
        { id: 'three', lens: 'correctness', paths: ['docs/a.md'], complete: true, findings: [] },
      ]),
    ])

    expect(report.projects[0]!.lenses[0]).toEqual({
      lens: 'correctness',
      disposition: 'propose',
      globs: ['src/**'],
      acceptedMediumPlus: { kept: 2, total: 2, share: 1 },
      runs: { skipped: 1, total: 3, share: 1 / 3, unrecorded: 0 },
    })
  })

  test('keeps a lens unscoped when its accepted findings are spread everywhere', () => {
    const report = proposeReviewScopes([
      project([
        {
          id: 'one',
          lens: 'correctness',
          paths: ['src/a.ts'],
          complete: true,
          findings: [finding],
        },
        {
          id: 'two',
          lens: 'correctness',
          paths: ['docs/a.md'],
          complete: true,
          findings: [finding],
        },
        {
          id: 'three',
          lens: 'correctness',
          paths: ['test/a.ts'],
          complete: true,
          findings: [finding],
        },
      ]),
    ])

    expect(report.projects[0]!.lenses[0]).toMatchObject({
      lens: 'correctness',
      disposition: 'keep-unscoped',
      globs: [],
      acceptedMediumPlus: { kept: 3, total: 3, share: 1 },
    })
  })
})
