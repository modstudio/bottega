import { expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'
import { canonMirrorFixtureRepository } from './canon-mirror-fixture.ts'

test('a canon lint finding stops publication before push', async () => {
  const root = canonMirrorFixtureRepository('canon-mirror-lint')
  let pushed = false
  try {
    installRecordApiClient(createMemoryRecordApiClient())
    upsertProject({
      name: 'canon-mirror-lint',
      path: root,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    await setDoc({
      scope: 'canon',
      subject: 'canon-mirror-lint',
      slug: 'AGENTS.md',
      title: 'AGENTS.md',
      body: 'Keep 123 rules.\n',
      reason: 'fixture lint finding',
      allowCanonBootstrap: true,
    })
    spawnFixtureGitSync(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-lint',
      dryRun: false,
      port: {
        ...systemCanonMirrorPort,
        fetch: () => {},
        push: () => {
          pushed = true
        },
        releaseRun: () => {
          const tree = join(root, '.claude/worktrees/canon-mirror')
          if (existsSync(tree))
            spawnFixtureGitSync(['worktree', 'remove', '--force', tree], { cwd: root })
          return { outcome: 'released', detail: 'fixture release' }
        },
      },
      noteFailure: async () => {},
    })
    expect(pushed).toBe(false)
    expect(results[0]).toMatchObject({ failed: true, text: expect.stringContaining('canon lint') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
