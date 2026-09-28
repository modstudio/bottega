import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('an unowned existing mirror path is refused and left intact', async () => {
  const root = mirrorRepository('cm-foreign-path')
  try {
    await registerManagedMirror(root, 'cm-foreign-path')
    const tree = join(root, '.claude', 'worktrees', 'canon-mirror')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'sentinel'), 'foreign\n')
    const result = await mirrorRepositoryCanon({
      project: 'cm-foreign-path',
      dryRun: false,
      port: mirrorFixturePort(root),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('refusing unowned canon mirror worktree')
    expect(existsSync(join(tree, 'sentinel'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
