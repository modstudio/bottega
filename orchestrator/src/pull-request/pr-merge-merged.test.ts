import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { adapter, cwd, pullRequest, registerProject } from './pr-merge.fixture.ts'
import { mergePullRequest } from './pr-merge.ts'

test('an already-merged pull request without a published merge commit names the condition', async () => {
  registerProject([])
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          view: () => ({ ...pullRequest, state: 'MERGED', mergeCommit: null }),
        }),
      ),
  ).toThrow(
    `refusing merge: GitHub reports pull request #42 merged but has published no merge commit; cleared by: once GitHub has published the merge commit, re-run ${PLATFORM_SLUG} pr merge 42`,
  )
})
