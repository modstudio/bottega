import { expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
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
      project: 'cm-leftover-reclaim', dryRun: false,
      port: mirrorFixturePort(root, {
        releaseRun: (id, preparation) => existsSync(tree) && base.treeDirty(tree)
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
      project: 'cm-leftover-dry', dryRun: true, port: mirrorFixturePort(root),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('owned leftover would be reset and released')
    expect(existsSync(tree)).toBe(true)
    expect(spawnFixtureGitSync(['status', '--porcelain'], { cwd: tree }).stdout.toString()).toBe(before)
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
    const result = await mirrorRepositoryCanon({
      project: 'cm-leftover-commit', dryRun: false,
      port: mirrorFixturePort(root, {
        releaseRun: () => ({ outcome: 'held', detail: 'refused; unpushed commit' }),
      }),
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('unpushed commit')
    expect(existsSync(tree)).toBe(true)
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
      project: 'cm-stage-cleanup', dryRun: false,
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
      project: 'cm-cause-cleanup', dryRun: false,
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
      project: 'cm-generated-write', dryRun: false,
      port: mirrorFixturePort(root, {
        lastPathCommit: (_root, _base, path) => path === 'AGENTS.override.md'
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
