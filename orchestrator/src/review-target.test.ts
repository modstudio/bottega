import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { declaredCreate, hermeticGitEnv, resolveReviewTarget, upsertProject, worktreeDescribeFixture } from "../test/fixture.ts"
describe('review target worktree recipes', () => {
const { fromRoot, scratchRepo } = worktreeDescribeFixture()
test('explicit review ignores a writing recipe with no {base} and no detached support', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'writing-recipe-review-fixture', path: repo,
      settings: {
        trunk: 'main',
        worktree: {
          create: declaredCreate('worktree-create', ['{branch}']),
          branch: 'review/{id}', seeds: [],
        },
      },
    })
    try {
      const tip = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'AB-2581^{commit}'], {
        env: hermeticGitEnv(), stdout: 'pipe',
      }).stdout.toString().trim()
      expect(fromRoot(() => resolveReviewTarget('review-lens', repo, 'AB-2581')))
        .toEqual({ branch: 'AB-2581', commit: tip, base: tip })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
