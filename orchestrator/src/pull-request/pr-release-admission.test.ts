import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import { assertPullRequestReleaseAdmission } from './pr-release-admission.ts'

test('a required release decision runs once and refuses before landing without the flag', () => {
  let decisions = 0
  const project = { name: 'fixture', path: '/fixture' } as Project
  expect(() =>
    assertPullRequestReleaseAdmission({
      project,
      cwd: '/fixture',
      pullRequest: { number: 42, headCommit: 'head', baseBranch: 'main' },
      adapter: {
        releaseDecision: () => {
          decisions++
          return { decided: true, required: ['hosted-api'], rungs: [], error: null }
        },
      },
      releaseRequired: false,
    }),
  ).toThrow(`${PLATFORM_SLUG} pr merge 42 --release-required`)
  expect(decisions).toBe(1)
})
