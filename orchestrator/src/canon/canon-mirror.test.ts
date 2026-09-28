import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { categorizeFile } from '../../../shared/file-kind.ts'
import { createMemoryRecordApiClient, installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { setDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import { classifyReviewTier } from '../review/review-tier.ts'
import { applyHydration } from './canon-apply.ts'
import {
  canonMirrorCommitBody,
  decideCanonMirrorMerge,
  mirrorRepositoryCanon,
  systemCanonMirrorPort,
} from './canon-mirror.ts'
import { planHydration } from './canon-hydrate.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'

describe('canon mirror commit body', () => {
  test('lists each changed path with latest store revision operation and reason', () => {
    expect(
      canonMirrorCommitBody([
        { path: 'AGENTS.md', revision: 'rev-2', op: 'update', reason: 'tighten rule' },
        {
          path: '.agents/rules/new.md',
          revision: 'rev-1',
          op: 'create',
          reason: 'add rule',
        },
      ]),
    ).toBe(
      '.agents/rules/new.md\nRevision: rev-1\nOperation: create\nReason: add rule\n\n' +
        'AGENTS.md\nRevision: rev-2\nOperation: update\nReason: tighten rule',
    )
  })
})

describe('canon mirror merge decision', () => {
  test('merges only an unchanged checked auto publication', () => {
    expect(
      decideCanonMirrorMerge({
        shipLevel: 'auto',
        headMatches: true,
        baseUnchanged: true,
        checks: 'passed',
      }),
    ).toEqual({ merge: true })
  })

  test.each([
    ['review', true, true, 'passed', 'ship autonomy is review'],
    ['auto', false, true, 'passed', 'pull-request head does not match'],
    ['auto', true, false, 'passed', 'landing branch changed'],
    ['auto', true, true, 'pending', 'GitHub checks are pending'],
    ['auto', true, true, 'failed', 'GitHub checks are failed'],
  ] as const)('leaves open when a merge predicate fails', (shipLevel, headMatches, baseUnchanged, checks, reason) => {
    expect(
      decideCanonMirrorMerge({ shipLevel, headMatches, baseUnchanged, checks }),
    ).toEqual({ merge: false, reason: expect.stringContaining(reason) })
  })
})

test('generated canon directory links classify as tier-zero docs', () => {
  for (const path of ['.claude/rules', '.agents/rules/contexts']) {
    expect(categorizeFile(path)).toBe('docs')
    expect(
      classifyReviewTier({ files: [{ path, insertions: 1, deletions: 1 }] }),
    ).toMatchObject({ tier: 0, risk: 0, size: 0 })
  }
})

function repository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`))
  spawnFixtureGitSync(['init'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.email', 'mirror@example.test'], { cwd: root })
  spawnFixtureGitSync(['config', 'user.name', 'Mirror Test'], { cwd: root })
  writeFileSync(join(root, 'README.txt'), 'fixture\n')
  spawnFixtureGitSync(['add', '.'], { cwd: root })
  spawnFixtureGitSync(['commit', '-m', 'fixture'], { cwd: root })
  return root
}

test('a managed project without a standing key is skipped as a failure', async () => {
  const root = repository('canon-mirror-missing-key')
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

test('an empty hydration plan closes its synthetic run without creating a tree', async () => {
  const root = repository('canon-mirror-empty')
  try {
    upsertProject({
      name: 'canon-mirror-empty',
      path: root,
      canon: true,
      settings: { managedContext: true, canonMirrorKey: 'DEV-1002', trunk: 'main' },
    })
    applyHydration(
      root,
      planHydration({ rows: storedRepositoryCanonRows('canon-mirror-empty'), tree: [] }),
    )
    spawnFixtureGitSync(['add', '.'], { cwd: root })
    if (spawnFixtureGitSync(['status', '--porcelain'], { cwd: root }).stdout.toString().trim()) {
      spawnFixtureGitSync(['commit', '-m', 'hydrate fixture'], { cwd: root })
    }
    spawnFixtureGitSync(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-empty',
      dryRun: false,
      port: { ...systemCanonMirrorPort, fetch: () => {} },
      noteFailure: async () => {},
    })
    expect(results).toEqual([
      { project: 'canon-mirror-empty', failed: false, text: 'nothing to do' },
    ])
    expect(existsSync(join(root, '.claude/worktrees/canon-mirror'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a canon lint finding stops publication before push', async () => {
  const root = repository('canon-mirror-lint')
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
          if (existsSync(tree)) spawnFixtureGitSync(['worktree', 'remove', '--force', tree], { cwd: root })
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
