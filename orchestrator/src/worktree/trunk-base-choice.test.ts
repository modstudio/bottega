import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addProject } from '../../test/fixtures/offline-branch-landing.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { db } from '../database/db.ts'
import { loadRecipeAtBase } from '../recipe/recipe-loader.ts'
import {
  chooseTrunkBase,
  resolveNewTreeBase,
  type TrunkBaseFacts,
  writerTreeBaseRef,
} from './trunk-base-choice.ts'
import { toolFor } from './worktree-preflight.ts'

const MAIN_AT_TRUNK: TrunkBaseFacts = {
  explicitBase: false,
  carry: false,
  callerIsRegisteredMain: true,
  callerBranch: 'main',
  landingBranch: 'main',
  callerHead: 'local-head',
  upstreamRef: 'origin/main',
  upstreamTip: 'upstream-tip',
  behindByFastForward: true,
  commitsBehind: 3,
}

const facts = (over: Partial<TrunkBaseFacts> = {}): TrunkBaseFacts => ({
  ...MAIN_AT_TRUNK,
  ...over,
})

test('a main checkout a fast-forward behind its upstream starts from the upstream tip', () => {
  expect(chooseTrunkBase(facts())).toEqual({
    base: 'upstream-tip',
    reason: 'upstream',
    upstreamRef: 'origin/main',
    behind: 3,
  })
})

test('a trunk already at the upstream tip keeps its own HEAD', () => {
  expect(
    chooseTrunkBase(
      facts({ upstreamTip: 'local-head', behindByFastForward: false, commitsBehind: 0 }),
    ),
  ).toEqual({ base: null, reason: 'at-upstream', upstreamRef: null, behind: 0 })
})

test('a trunk ahead of, or diverged from, its upstream keeps its own HEAD', () => {
  expect(chooseTrunkBase(facts({ behindByFastForward: false, commitsBehind: 0 }))).toEqual({
    base: null,
    reason: 'not-fast-forward',
    upstreamRef: null,
    behind: 0,
  })
})

test('an explicitly named base stands even when the trunk is behind', () => {
  expect(chooseTrunkBase(facts({ explicitBase: true }))).toEqual({
    base: null,
    reason: 'explicit-base',
    upstreamRef: null,
    behind: 0,
  })
})

test('--carry keeps the caller HEAD as the base even when the trunk is behind', () => {
  expect(chooseTrunkBase(facts({ carry: true }))).toEqual({
    base: null,
    reason: 'carry',
    upstreamRef: null,
    behind: 0,
  })
})

test('a caller that is a worktree rather than the main checkout keeps its own HEAD', () => {
  expect(chooseTrunkBase(facts({ callerIsRegisteredMain: false }))).toEqual({
    base: null,
    reason: 'not-registered-main-checkout',
    upstreamRef: null,
    behind: 0,
  })
})

test('a main checkout on another branch keeps its own HEAD', () => {
  expect(chooseTrunkBase(facts({ callerBranch: 'DEV-1513-topic' }))).toEqual({
    base: null,
    reason: 'not-on-landing-branch',
    upstreamRef: null,
    behind: 0,
  })
  expect(chooseTrunkBase(facts({ callerBranch: null }))).toEqual({
    base: null,
    reason: 'not-on-landing-branch',
    upstreamRef: null,
    behind: 0,
  })
})

test('an upstream that does not resolve keeps the caller HEAD', () => {
  expect(chooseTrunkBase(facts({ upstreamRef: null }))).toEqual({
    base: null,
    reason: 'no-upstream',
    upstreamRef: null,
    behind: 0,
  })
  expect(chooseTrunkBase(facts({ upstreamTip: null }))).toEqual({
    base: null,
    reason: 'no-upstream',
    upstreamRef: null,
    behind: 0,
  })
})

test('a project without a declared landing branch keeps the caller HEAD', () => {
  expect(chooseTrunkBase(facts({ landingBranch: null, callerBranch: null }))).toEqual({
    base: null,
    reason: 'not-on-landing-branch',
    upstreamRef: null,
    behind: 0,
  })
})

test('an unreadable caller HEAD leaves the base unresolved', () => {
  expect(chooseTrunkBase(facts({ callerHead: null }))).toEqual({
    base: null,
    reason: 'unresolved-head',
    upstreamRef: null,
    behind: 0,
  })
})

/**
 * A stale registered main checkout whose project names its own floor.
 *
 * Trunk is one commit ahead of the caller and the tracked recipe declares
 * `baseRef`, which is what a project that branches from `origin/develop` says.
 * `writerTreeBaseRef` is the value run claiming hands to creation, so building
 * the tree's base through the loader with it is the same expression creation
 * evaluates.
 *
 * `recipeAtRecipeBase` is the recipe committed at the base the declaration
 * points at, which is where following the declaration reads next. It defaults
 * to the same recipe, and a project whose target commit names no base of its
 * own passes a recipe that omits `baseRef`.
 */
function withStaleMainCheckout(
  recipe: string,
  run: (fixture: {
    repo: string
    recipePath: string
    upstreamTip: string
    recipeBaseTip: string
  }) => void,
  recipeAtRecipeBase = recipe,
): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trunk-base-choice-')))
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnFixtureGitSync(args, { cwd })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  try {
    const repo = join(root, 'app')
    const recipePath = 'worktree.jsonc'
    git(root, 'init', '--quiet', '-b', 'main', repo)
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'config', 'user.email', 'fixture@example.com')
    writeFileSync(join(repo, recipePath), recipe)
    writeFileSync(join(repo, 'app.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '--quiet', '-b', 'recipe-base')
    writeFileSync(join(repo, recipePath), recipeAtRecipeBase)
    writeFileSync(join(repo, 'recipe-base.txt'), 'the base this project names\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'recipe base')
    const recipeBaseTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '--quiet', 'main')
    writeFileSync(join(repo, 'landed.txt'), 'landed remotely\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'landed remotely')
    const upstreamTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', upstreamTip)
    git(repo, 'config', 'branch.main.remote', 'origin')
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
    // The registered main checkout lags the remote by one fast-forward commit.
    git(repo, 'reset', '--hard', '--quiet', base)

    const recordId = addProject('trunk-base-choice-fixture', repo)
    db()
      .query('UPDATE project SET settings=? WHERE record_id=?')
      .run(JSON.stringify({ trunk: 'main', worktree: { recipePath } }), recordId)

    run({ repo, recipePath, upstreamTip, recipeBaseTip })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a stale main checkout whose tracked recipe names a base keeps the recipe base', () => {
  withStaleMainCheckout('{ "worktree": { "create": [], "baseRef": "recipe-base" } }', (fixture) => {
    // Without the recipe's own base the substitution is live for this caller,
    // so the recipe base surviving is the guard's doing and not an absent
    // stale trunk.
    expect(resolveNewTreeBase({ cwd: fixture.repo, ref: null })).toBe(fixture.upstreamTip)

    const baseRef = writerTreeBaseRef(toolFor(fixture.repo), fixture.repo, fixture.repo, false)
    expect(baseRef).toBeUndefined()
    expect(
      loadRecipeAtBase({
        recipePath: fixture.recipePath,
        repoRoot: fixture.repo,
        baseRef,
      }).base,
    ).toBe(fixture.recipeBaseTip)
  })
})

test('a declared base whose target commit names none still keeps the recipe base', () => {
  withStaleMainCheckout(
    '{ "worktree": { "create": [], "baseRef": "recipe-base" } }',
    (fixture) => {
      // The caller's trunk is behind the upstream, so the substitution is live
      // for this caller and the declared base winning is the guard's doing.
      expect(resolveNewTreeBase({ cwd: fixture.repo, ref: null })).toBe(fixture.upstreamTip)

      const baseRef = writerTreeBaseRef(toolFor(fixture.repo), fixture.repo, fixture.repo, false)
      expect(baseRef).toBeUndefined()
      expect(
        loadRecipeAtBase({ recipePath: fixture.recipePath, repoRoot: fixture.repo, baseRef }).base,
      ).toBe(fixture.recipeBaseTip)
    },
    '{ "worktree": { "create": [] } }',
  )
})

test('a tracked recipe that names no base takes the landing upstream', () => {
  withStaleMainCheckout('{ "worktree": { "create": [] } }', (fixture) => {
    const baseRef = writerTreeBaseRef(toolFor(fixture.repo), fixture.repo, fixture.repo, false)

    expect(baseRef).toBe(fixture.upstreamTip)
    expect(
      loadRecipeAtBase({ recipePath: fixture.recipePath, repoRoot: fixture.repo, baseRef }).base,
    ).toBe(fixture.upstreamTip)
  })
})

test('a project whose register declares the recipe base keeps it too', () => {
  const baseRef = writerTreeBaseRef(
    { recipe: { baseRef: 'origin/develop' } },
    '/not/a/checkout',
    '/not/a/checkout',
    false,
  )

  expect(baseRef).toBeUndefined()
})
