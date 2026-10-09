import { expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'
import { mirrorRepository } from './canon-mirror-ownership.fixture.ts'

test('an empty project canon store refuses publication and leaves other projects in the pass free', async () => {
  const root = mirrorRepository('canon-mirror-empty-store')
  try {
    await setDoc({
      scope: 'canon',
      subject: null,
      slug: '.agents/reference/global.md',
      title: '.agents/reference/global.md',
      body: 'Global reference.\n',
      reason: 'seed a global row',
      allowCanonBootstrap: true,
    })
    upsertProject({
      name: 'canon-mirror-empty-store',
      path: root,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    upsertProject({
      name: 'canon-mirror-empty-store-other',
      path: root,
      canon: true,
      settings: { managedContext: true, trunk: 'main' },
    })
    writeFileSync(join(root, 'AGENTS.md'), 'Keep the tree.\n')
    spawnFixtureGitSync(['add', 'AGENTS.md'], { cwd: root })
    spawnFixtureGitSync(['commit', '-m', 'canon'], { cwd: root })
    spawnFixtureGitSync(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })

    const results = await mirrorRepositoryCanon({
      dryRun: false,
      port: {
        ...systemCanonMirrorPort,
        fetch: () => {},
        localBranch: () => false,
        remoteBranchTip: () => null,
        releaseRun: () => ({ outcome: 'released', detail: 'fixture release' }),
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
          project: 'canon-mirror-empty-store-other',
          failed: true,
          text: expect.stringContaining('canonMirrorKey'),
        }),
      ]),
    )
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(root, '.claude/worktrees/canon-mirror'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
