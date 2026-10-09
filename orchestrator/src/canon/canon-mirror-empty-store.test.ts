import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { applyHydration } from './canon-apply.ts'
import { planHydration } from './canon-hydrate.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'

function repository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  spawnFixtureGitSync(['init'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.email', 'mirror@example.test'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.name', 'Mirror Test'], { cwd: root })
  writeFileSync(join(root, 'README.txt'), 'fixture\n')
  spawnFixtureGitSync(['add', '.'], { cwd: root })
  spawnFixtureGitSync(['commit', '-m', 'fixture'], { cwd: root })
  return root
}

function commitTree(root: string): void {
  spawnFixtureGitSync(['add', '.'], { cwd: root })
  if (spawnFixtureGitSync(['status', '--porcelain'], { cwd: root }).stdout.toString().trim()) {
    spawnFixtureGitSync(['commit', '-m', 'hydrate fixture'], { cwd: root })
  }
  spawnFixtureGitSync(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
}

test('an empty project canon store refuses publication and leaves other projects in the pass free', async () => {
  const emptyRoot = repository('canon-mirror-empty-store')
  const healthyRoot = repository('canon-mirror-empty-store-ok')
  try {
    upsertProject({
      name: 'canon-mirror-empty-store',
      path: emptyRoot,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    upsertProject({
      name: 'canon-mirror-empty-store-ok',
      path: healthyRoot,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    await setDoc({
      scope: 'canon',
      subject: null,
      slug: '.agents/rules/global.md',
      title: '.agents/rules/global.md',
      body: '---\ndescription: Global\nalways: true\n---\n\nGlobal rule.\n',
      reason: 'seed a global row',
      allowCanonBootstrap: true,
    })
    await setDoc({
      scope: 'canon',
      subject: 'canon-mirror-empty-store-ok',
      slug: 'AGENTS.md',
      title: 'AGENTS.md',
      body: 'Managed context.\n',
      reason: 'seed a project row',
      allowCanonBootstrap: true,
    })
    applyHydration(
      healthyRoot,
      planHydration({
        rows: storedRepositoryCanonRows('canon-mirror-empty-store-ok'),
        tree: [],
      }),
    )
    commitTree(healthyRoot)
    writeFileSync(join(emptyRoot, 'AGENTS.md'), 'Keep the tree.\n')
    commitTree(emptyRoot)

    const results = await mirrorRepositoryCanon({
      dryRun: false,
      port: {
        ...systemCanonMirrorPort,
        fetch: () => {},
        remoteBranchTip: () => null,
      },
      noteFailure: async () => {},
    })

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project: 'canon-mirror-empty-store',
          failed: true,
          text: expect.stringContaining('this store holds no project canon'),
        }),
        expect.objectContaining({
          project: 'canon-mirror-empty-store-ok',
          failed: false,
          text: 'nothing to do',
        }),
      ]),
    )
    expect(existsSync(join(emptyRoot, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(emptyRoot, '.claude/worktrees/canon-mirror'))).toBe(false)
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
    rmSync(healthyRoot, { recursive: true, force: true })
  }
})
