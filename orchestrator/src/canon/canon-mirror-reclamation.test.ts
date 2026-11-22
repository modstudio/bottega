import { expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDoc } from '../../test/fixtures/doc-local-read.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { removeDoc, setDoc } from '../doc/docs.ts'
import { readWorktreeMarker } from '../worktree/worktree-attribution.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

async function leaveDirtyOwnedTree(root: string, project: string): Promise<string> {
  await registerManagedMirror(root, project)
  const base = mirrorFixturePort(root)
  const result = await mirrorRepositoryCanon({
    project,
    dryRun: false,
    port: mirrorFixturePort(root, {
      stage: (path) => {
        base.stage(path)
        throw new Error('fixture failure after staging')
      },
      resetTree: () => {},
      releaseRun: () => ({ outcome: 'held', detail: 'refused; dirty fixture tree' }),
    }),
    noteFailure: async () => {},
  })
  expect(result[0]?.text).toContain('fixture failure after staging')
  return join(root, '.claude', 'worktrees', 'canon-mirror')
}

function commitHydratedCanon(root: string): void {
  const tree = join(root, '.claude', 'worktrees', 'canon-mirror')
  writeFileSync(join(root, 'AGENTS.md'), readFileSync(join(tree, 'AGENTS.md')))
  writeFileSync(join(root, 'AGENTS.override.md'), readFileSync(join(tree, 'AGENTS.override.md')))
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'))
  spawnFixtureGitSync(['add', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md'], { cwd: root })
  spawnFixtureGitSync(['commit', '-m', 'fixture hydrated canon'], { cwd: root })
}

test('a no-drift pass reclaims a dirty owned leftover', async () => {
  const root = mirrorRepository('cm-leftover-reclaim')
  try {
    const tree = await leaveDirtyOwnedTree(root, 'cm-leftover-reclaim')
    commitHydratedCanon(root)
    const base = mirrorFixturePort(root)
    const result = await mirrorRepositoryCanon({
      project: 'cm-leftover-reclaim',
      dryRun: false,
      port: mirrorFixturePort(root, {
        releaseRun: (id, preparation) =>
          existsSync(tree) && base.treeDirty(tree) === true
            ? { outcome: 'held', detail: 'refused; dirty fixture tree' }
            : base.releaseRun(id, preparation),
      }),
      noteFailure: async () => {},
    })
    expect(result[0]).toMatchObject({ failed: false, text: 'nothing to do' })
    expect(existsSync(tree)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry-run reports a dirty owned leftover without touching it', async () => {
  const root = mirrorRepository('cm-leftover-dry')
  try {
    const tree = await leaveDirtyOwnedTree(root, 'cm-leftover-dry')
    commitHydratedCanon(root)
    const before = spawnFixtureGitSync(['status', '--porcelain'], { cwd: tree }).stdout.toString()
    const result = await mirrorRepositoryCanon({
      project: 'cm-leftover-dry',
      dryRun: true,
      port: mirrorFixturePort(root),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('owned leftover would be reset and released')
    expect(existsSync(tree)).toBe(true)
    expect(spawnFixtureGitSync(['status', '--porcelain'], { cwd: tree }).stdout.toString()).toBe(
      before,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an owned leftover with an unpushed commit remains refused', async () => {
  const root = mirrorRepository('cm-leftover-commit')
  try {
    const tree = await leaveDirtyOwnedTree(root, 'cm-leftover-commit')
    spawnFixtureGitSync(['commit', '-m', 'fixture unpushed canon'], { cwd: tree })
    commitHydratedCanon(root)
    const leftoverRunId = readWorktreeMarker(tree).runRecordId
    let leftoverReleaseCalled = false
    const base = mirrorFixturePort(root)
    const result = await mirrorRepositoryCanon({
      project: 'cm-leftover-commit',
      dryRun: false,
      port: mirrorFixturePort(root, {
        releaseRun: (runId, preparation) => {
          if (runId === leftoverRunId) leftoverReleaseCalled = true
          return base.releaseRun(runId, preparation)
        },
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('unpushed commit')
    expect(existsSync(tree)).toBe(true)
    expect(leftoverReleaseCalled).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dirty leftover with an unrelated remote mirror tip is reclaimed', async () => {
  const root = mirrorRepository('cm-leftover-remote-tip')
  try {
    const tree = await leaveDirtyOwnedTree(root, 'cm-leftover-remote-tip')
    commitHydratedCanon(root)
    const treeHash = spawnFixtureGitSync(['rev-parse', 'HEAD^{tree}'], { cwd: root })
      .stdout.toString()
      .trim()
    const unrelatedTip = spawnFixtureGitSync(
      ['commit-tree', treeHash, '-m', 'unrelated squash result'],
      { cwd: root },
    )
      .stdout.toString()
      .trim()
    const result = await mirrorRepositoryCanon({
      project: 'cm-leftover-remote-tip',
      dryRun: false,
      port: mirrorFixturePort(root, { remoteBranchTip: () => unrelatedTip }),
      noteFailure: async () => {},
    })
    expect(result[0]).toMatchObject({ failed: false, text: 'nothing to do' })
    expect(existsSync(tree)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an owned leftover with indeterminate cleanliness is refused intact', async () => {
  const root = mirrorRepository('cm-leftover-indeterminate')
  try {
    const tree = await leaveDirtyOwnedTree(root, 'cm-leftover-indeterminate')
    commitHydratedCanon(root)
    const leftoverRunId = readWorktreeMarker(tree).runRecordId
    let leftoverReleaseCalled = false
    const base = mirrorFixturePort(root)
    const result = await mirrorRepositoryCanon({
      project: 'cm-leftover-indeterminate',
      dryRun: false,
      port: mirrorFixturePort(root, {
        treeDirty: () => 'indeterminate',
        releaseRun: (runId, preparation) => {
          if (runId === leftoverRunId) leftoverReleaseCalled = true
          return base.releaseRun(runId, preparation)
        },
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('cleanliness is indeterminate')
    expect(existsSync(tree)).toBe(true)
    expect(leftoverReleaseCalled).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failure after staging is reset and released without masking its cause', async () => {
  const root = mirrorRepository('cm-stage-cleanup')
  try {
    await registerManagedMirror(root, 'cm-stage-cleanup')
    const base = mirrorFixturePort(root)
    const result = await mirrorRepositoryCanon({
      project: 'cm-stage-cleanup',
      dryRun: false,
      port: mirrorFixturePort(root, {
        stage: (path) => {
          base.stage(path)
          throw new Error('canon lint fixture refusal')
        },
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('canon lint fixture refusal')
    expect(existsSync(join(root, '.claude', 'worktrees', 'canon-mirror'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cleanup failure is appended to the publication failure', async () => {
  const root = mirrorRepository('cm-cause-cleanup')
  try {
    await registerManagedMirror(root, 'cm-cause-cleanup')
    const base = mirrorFixturePort(root)
    const result = await mirrorRepositoryCanon({
      project: 'cm-cause-cleanup',
      dryRun: false,
      port: mirrorFixturePort(root, {
        stage: (path) => {
          base.stage(path)
          throw new Error('original fixture refusal')
        },
        releaseRun: () => ({ outcome: 'held', detail: 'fixture cleanup refusal' }),
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('original fixture refusal')
    expect(result[0]?.text).toContain('fixture cleanup refusal')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a generated file newer than its contributors is still generated', async () => {
  const root = mirrorRepository('cm-generated-write')
  try {
    await registerManagedMirror(root, 'cm-generated-write')
    const result = await mirrorRepositoryCanon({
      project: 'cm-generated-write',
      dryRun: false,
      port: mirrorFixturePort(root, {
        lastPathCommit: (_root, _base, path) =>
          path === 'AGENTS.override.md'
            ? { sha: 'abcdef0123456789', at: '2099-01-01T00:00:00Z' }
            : null,
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('PR opened')
    expect(result[0]?.text).not.toContain('refusing canon mirror change')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a generated path newer than its contributors is deleted without refusal', async () => {
  const root = mirrorRepository('cm-generated-delete')
  try {
    await leaveDirtyOwnedTree(root, 'cm-generated-delete')
    commitHydratedCanon(root)
    await setDoc({
      scope: 'canon',
      subject: 'cm-generated-delete',
      slug: '.agents/reference/keep.md',
      title: 'keep',
      body: '---\ndescription: Fixture remaining reference\n---\n\nKeep this reference.\n',
      reason: 'fixture remaining row',
      allowCanonBootstrap: true,
    })
    const entry = getDoc('canon', 'cm-generated-delete', 'AGENTS.md')!
    await removeDoc('canon', 'cm-generated-delete', 'AGENTS.md', {
      reason: 'fixture retire generated contributor',
      expectedRevision: entry.revision!,
      canonRemovalDecision: 'already-decided-next-set',
    })
    const base = mirrorFixturePort(root)
    let deletedBeforeStage = false
    const result = await mirrorRepositoryCanon({
      project: 'cm-generated-delete',
      dryRun: false,
      port: mirrorFixturePort(root, {
        lastPathCommit: (_root, _base, path) =>
          path === 'AGENTS.override.md'
            ? { sha: 'abcdef0123456789', at: '2099-01-01T00:00:00Z' }
            : null,
        stage: (path) => {
          deletedBeforeStage = !existsSync(join(path, 'AGENTS.override.md'))
          base.stage(path)
        },
      }),
      noteFailure: async () => {},
    })
    expect(deletedBeforeStage).toBe(true)
    expect(result[0]?.text).toContain('PR opened')
    expect(result[0]?.text).not.toContain('refusing canon mirror change')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a branch-newer stored canon file refuses publication through the real guard', async () => {
  const root = mirrorRepository('cm-write-guard-wiring')
  try {
    await registerManagedMirror(root, 'cm-write-guard-wiring')
    let opened = false
    const result = await mirrorRepositoryCanon({
      project: 'cm-write-guard-wiring',
      dryRun: false,
      port: mirrorFixturePort(root, {
        lastPathCommit: (_root, _base, path) =>
          path === 'AGENTS.md' ? { sha: 'abcdef0123456789', at: '2099-01-01T00:00:00Z' } : null,
        openPullRequest: () => {
          opened = true
          throw new Error('fixture should not open a pull request')
        },
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('refusing canon mirror change')
    expect(result[0]?.text).toContain('AGENTS.md')
    expect(result[0]?.text).toContain('abcdef0123')
    expect(result[0]?.text).toContain('doc set --scope canon --subject cm-write-guard-wiring')
    expect(opened).toBe(false)
    expect(existsSync(join(root, '.claude', 'worktrees', 'canon-mirror'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
