import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { mirrorRepositoryCanon, systemCanonMirrorPort } from './canon-mirror.ts'

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'canon-mirror-lint-'))
  spawnFixtureGitSync(['init'], { cwd: root })
  spawnFixtureGitSync(
    [
      '-c',
      'user.email=mirror@example.test',
      '-c',
      'user.name=Mirror Test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { cwd: root },
  )
  return root
}

test('a hydration that introduces a canon lint finding stops publication before push', async () => {
  const root = repository()
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
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-lint',
      dryRun: false,
      port: {
        ...systemCanonMirrorPort,
        fetch: () => {},
        refTip: () => 'HEAD',
        remoteBranchTip: () => null,
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
