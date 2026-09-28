import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { systemCanonMirrorPort } from './canon-mirror.ts'
import { mirrorRepository } from './canon-mirror-ownership.fixture.ts'

test('update-ref branch release refuses a branch that moved', () => {
  const root = mirrorRepository('cm-update-ref')
  try {
    const original = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: root })
      .stdout.toString()
      .trim()
    spawnFixtureGitSync(['branch', 'DEV-1002-canon-mirror', original], { cwd: root })
    spawnFixtureGitSync(['commit', '--allow-empty', '-m', 'foreign move'], { cwd: root })
    const moved = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
    spawnFixtureGitSync(['branch', '-f', 'DEV-1002-canon-mirror', moved], { cwd: root })
    const project = { path: root } as Parameters<typeof systemCanonMirrorPort.releaseBranch>[0]
    expect(() =>
      systemCanonMirrorPort.releaseBranch(project, 'DEV-1002-canon-mirror', original),
    ).toThrow()
    expect(
      spawnFixtureGitSync(['rev-parse', 'DEV-1002-canon-mirror'], { cwd: root })
        .stdout.toString()
        .trim(),
    ).toBe(moved)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
