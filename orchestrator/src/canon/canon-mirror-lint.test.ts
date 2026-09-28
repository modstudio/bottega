import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  spawnFixtureGitSync(['config', 'user.email', 'mirror@example.test'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.name', 'Mirror Test'], { cwd: root })
  writeFileSync(join(root, 'README.txt'), 'fixture\n')
  spawnFixtureGitSync(['add', '.'], { cwd: root })
  spawnFixtureGitSync(['commit', '-m', 'fixture'], { cwd: root })
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

test('a pre-existing canon lint finding does not stop publication', async () => {
  const root = repository()
  let pushed = false
  try {
    installRecordApiClient(createMemoryRecordApiClient())
    upsertProject({
      name: 'canon-mirror-baseline-lint',
      path: root,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    writeFileSync(join(root, 'AGENTS.md'), 'Keep 123 rules.\n')
    spawnFixtureGitSync(['add', '.'], { cwd: root })
    spawnFixtureGitSync(['commit', '-m', 'baseline canon finding'], { cwd: root })
    await setDoc({
      scope: 'canon',
      subject: 'canon-mirror-baseline-lint',
      slug: 'AGENTS.md',
      title: 'AGENTS.md',
      body: 'Keep 123 rules.\n',
      reason: 'preserve baseline lint finding',
      allowCanonBootstrap: true,
    })
    await setDoc({
      scope: 'canon',
      subject: 'canon-mirror-baseline-lint',
      slug: '.agents/rules/new.md',
      title: 'New rule',
      body:
        '---\ndescription: Fixture managed-context rule\nalways: true\n---\n\nKeep managed context current.\n',
      reason: 'fixture hydration change',
      allowCanonBootstrap: true,
    })
    spawnFixtureGitSync(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-baseline-lint',
      dryRun: false,
      port: {
        ...systemCanonMirrorPort,
        fetch: () => {},
        push: () => {
          pushed = true
        },
        pullRequest: () => null,
        openPullRequest: () => ({
          number: 1,
          url: 'https://example.test/pull/1',
          headSha: 'different-head',
          checks: 'passed',
        }),
        releaseRun: () => {
          const tree = join(root, '.claude/worktrees/canon-mirror')
          if (existsSync(tree))
            spawnFixtureGitSync(['worktree', 'remove', '--force', tree], { cwd: root })
          return { outcome: 'released', detail: 'fixture release' }
        },
      },
      noteFailure: async () => {},
    })
    expect(results[0]).toMatchObject({ failed: false, text: expect.stringContaining('PR opened') })
    expect(pushed).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
