import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { upsertProject } from '../project/projects.ts'
import { applyHydration } from './canon-apply.ts'
import { planHydration } from './canon-hydrate.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'canon-mirror-empty-'))
  spawnFixtureGitSync(['init'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.email', 'mirror@example.test'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.name', 'Mirror Test'], { cwd: root })
  writeFileSync(join(root, 'README.txt'), 'fixture\n')
  spawnFixtureGitSync(['add', '.'], { cwd: root })
  spawnFixtureGitSync(['commit', '-m', 'fixture'], { cwd: root })
  return root
}

test('an empty hydration plan closes its synthetic run without creating a tree', async () => {
  const root = repository()
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
