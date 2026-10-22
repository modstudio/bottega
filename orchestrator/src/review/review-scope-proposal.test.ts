import { describe, expect, test } from 'bun:test'
import {
  proposeReviewScopes,
  type ReviewScopeProject,
  renderReviewScopeProposalHuman,
} from './review-scope-proposal.ts'

const finding = { disposition: 'accepted', triaged_severity: 'medium' }

function run(
  value: Omit<ReviewScopeProject['runs'][number], 'productPaths'> & { productPaths?: string[] },
): ReviewScopeProject['runs'][number] {
  return { ...value, productPaths: value.productPaths ?? value.paths }
}

function project(runs: ReviewScopeProject['runs']): ReviewScopeProject {
  return {
    project: 'fixture',
    topLevelDirectories: ['docs', 'lib', 'other', 'src', 'test'],
    review: {
      lenses: [
        { lens: 'correctness' },
        { lens: 'craft' },
        { lens: 'test-quality', paths: ['**/*.test.ts'] },
      ],
    },
    runs,
  }
}

describe('review scope proposal', () => {
  test('proposes the one directory containing all accepted medium+ findings', () => {
    const report = proposeReviewScopes([
      project([
        run({
          id: 'one',
          lens: 'craft',
          paths: ['src/a.ts'],
          complete: true,
          findings: [finding],
        }),
        run({
          id: 'two',
          lens: 'craft',
          paths: ['src/b.ts'],
          complete: true,
          findings: [finding],
        }),
        run({
          id: 'three',
          lens: 'craft',
          paths: ['docs/a.md'],
          productPaths: [],
          complete: true,
          findings: [],
        }),
      ]),
    ])

    expect(report.projects[0]!.lenses[1]).toEqual({
      lens: 'craft',
      disposition: 'propose',
      globs: ['src/**'],
      acceptedMediumPlus: { kept: 2, total: 2, share: 1 },
      runs: { skipped: 1, total: 3, share: 1 / 3, unrecorded: 0 },
    })
  })

  test('keeps a lens unscoped when its accepted findings are spread everywhere', () => {
    const report = proposeReviewScopes([
      project([
        run({
          id: 'one',
          lens: 'craft',
          paths: ['src/a.ts'],
          complete: true,
          findings: [finding],
        }),
        run({
          id: 'two',
          lens: 'craft',
          paths: ['lib/a.ts'],
          complete: true,
          findings: [finding],
        }),
        run({
          id: 'three',
          lens: 'craft',
          paths: ['other/a.ts'],
          complete: true,
          findings: [finding],
        }),
      ]),
    ])

    expect(report.projects[0]!.lenses[1]).toMatchObject({
      lens: 'craft',
      disposition: 'keep-unscoped',
      globs: [],
      acceptedMediumPlus: { kept: 3, total: 3, share: 1 },
    })
  })

  test('ignores test paths when findings span product directories', () => {
    const report = proposeReviewScopes([
      project([
        run({
          id: 'one',
          lens: 'craft',
          paths: ['src/a.ts', 'src/a.test.ts'],
          productPaths: ['src/a.ts'],
          complete: true,
          findings: [finding],
        }),
        run({
          id: 'two',
          lens: 'craft',
          paths: ['lib/b.ts', 'lib/b.test.ts'],
          productPaths: ['lib/b.ts'],
          complete: true,
          findings: [finding],
        }),
      ]),
    ])

    expect(report.projects[0]!.lenses[1]).toMatchObject({
      lens: 'craft',
      disposition: 'keep-unscoped',
      globs: [],
      acceptedMediumPlus: { kept: 2, total: 2, share: 1 },
    })
  })

  test('lists correctness as always relevant instead of proposing a scope', () => {
    const report = proposeReviewScopes([
      project([
        run({
          id: 'one',
          lens: 'correctness',
          paths: ['src/a.ts'],
          complete: true,
          findings: [finding],
        }),
      ]),
    ])

    expect(report.projects[0]!.lenses[0]).toEqual({
      lens: 'correctness',
      disposition: 'always-relevant',
      globs: [],
      acceptedMediumPlus: { kept: 1, total: 1, share: 1 },
      runs: { skipped: 0, total: 1, share: 0, unrecorded: 0 },
    })
    expect(renderReviewScopeProposalHuman(report)).toContain(
      'correctness: always relevant (not scoped)',
    )
  })
})
