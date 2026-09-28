import { expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { upsertProject } from '../project/projects.ts'
import { applyHydration } from './canon-apply.ts'
import { planHydration } from './canon-hydrate.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'
import { canonMirrorFixtureRepository } from './canon-mirror-fixture.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'

test('an empty hydration plan closes its synthetic run without creating a tree', async () => {
  const root = canonMirrorFixtureRepository('canon-mirror-empty')
  try {
    upsertProject({
      name: 'canon-mirror-empty',
      path: root,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    applyHydration(
      root,
      planHydration({ rows: storedRepositoryCanonRows('canon-mirror-empty'), tree: [] }),
    )
    spawnFixtureGitSync(['add', '.'], { cwd: root })
    if (spawnFixtureGitSync(['status', '--porcelain'], { cwd: root }).stdout.toString().trim()) {
      spawnFixtureGitSync(['commit', '-m', 'hydrate fixture'], { cwd: root })
    }
    spawnFixtureGitSync(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-empty',
      dryRun: false,
      port: { ...systemCanonMirrorPort, fetch: () => {} },
      noteFailure: async () => {},
    })
    expect(results).toEqual([
      { project: 'canon-mirror-empty', failed: false, text: 'nothing to do' },
    ])
    expect(existsSync(join(root, '.claude/worktrees/canon-mirror'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
