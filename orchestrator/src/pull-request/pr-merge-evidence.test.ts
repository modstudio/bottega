import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refuseMergedWithoutCommit } from './pr-merge-evidence.ts'

test('a merge-commit lookup failure still records landing and CI evidence', () => {
  const evidence: string[] = []
  expect(() =>
    refuseMergedWithoutCommit({
      adapter: {
        recordLandings: () => evidence.push('landing'),
        recordCi: () => {
          evidence.push('ci')
          return undefined
        },
      },
      change: { branch: 'DEV-1960-fix' } as never,
      pullRequest: { number: 42 } as never,
      database: {} as Database,
      projectName: 'fixture',
      cause: new Error('merge-commit lookup failed: forge unavailable'),
      target: '42',
    }),
  ).toThrow(
    `pull request #42 merged, but the merge commit could not be read: merge-commit lookup failed: forge unavailable; retry with: ${PLATFORM_SLUG} pr merge 42`,
  )
  expect(evidence).toEqual(['landing', 'ci'])
})
