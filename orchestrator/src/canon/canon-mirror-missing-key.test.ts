import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { upsertProject } from '../project/projects.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'canon-mirror-missing-key-'))
  spawnFixtureGitSync(['init'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.email', 'mirror@example.test'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.name', 'Mirror Test'], { cwd: root })
  writeFileSync(join(root, 'README.txt'), 'fixture\n')
  spawnFixtureGitSync(['add', '.'], { cwd: root })
  spawnFixtureGitSync(['commit', '-m', 'fixture'], { cwd: root })
  return root
}

test('a managed project without a standing key is skipped as a failure', async () => {
  const root = repository()
  try {
    upsertProject({
      name: 'canon-mirror-missing-key',
      path: root,
      canon: true,
      settings: { managedContext: true, trunk: 'main' },
    })
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-missing-key',
      dryRun: true,
    })
    expect(results).toEqual([
      expect.objectContaining({ failed: true, text: expect.stringContaining('canonMirrorKey') }),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
