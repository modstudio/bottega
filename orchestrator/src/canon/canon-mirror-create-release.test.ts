import { expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('a createTree failure after recording the tree still releases it', async () => {
  const root = mirrorRepository('cm-create-fail')
  let released = false
  try {
    await registerManagedMirror(root, 'cm-create-fail')
    const base = mirrorFixturePort(root)
    const port = mirrorFixturePort(root, {
      createTree: (input) => {
        base.createTree(input)
        throw new Error('fixture failure after create')
      },
      releaseRun: (id) => {
        released = true
        return base.releaseRun(id)
      },
    })
    const result = await mirrorRepositoryCanon({
      project: 'cm-create-fail',
      dryRun: false,
      port,
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('fixture failure after create')
    expect(released).toBe(true)
    expect(existsSync(join(root, '.claude', 'worktrees', 'canon-mirror'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
