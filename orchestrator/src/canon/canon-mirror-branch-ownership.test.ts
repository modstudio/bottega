import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { mirrorFixturePort, mirrorRepository, registerManagedMirror } from './canon-mirror-ownership.fixture.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'

test('an unowned local mirror branch is refused', async () => {
  const root = mirrorRepository('cm-foreign-branch')
  try {
    await registerManagedMirror(root, 'cm-foreign-branch')
    spawnFixtureGitSync(['branch', 'DEV-1002-canon-mirror', 'HEAD'], { cwd: root })
    const result = await mirrorRepositoryCanon({ project: 'cm-foreign-branch', dryRun: false, port: mirrorFixturePort(root), noteFailure: async () => {} })
    expect(result[0]?.text).toContain('refusing unowned local branch')
    expect(spawnFixtureGitSync(['show-ref', '--verify', '--quiet', 'refs/heads/DEV-1002-canon-mirror'], { cwd: root }).exitCode).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
