import { expect, test } from 'bun:test'
import type { Project } from '../project/projects.ts'
import {
  ensureCommitWithGit,
  type ReleaseAtCommitDependencies,
  type ReleaseTreeLifecycle,
  releaseAtCommit,
} from './release-at-commit.ts'
import type { CheckoutReleaseTarget, ReleaseResult } from './release-service.ts'

const project = {
  name: 'fixture',
  path: '/projects/fixture',
  settings: { trunk: 'main' },
} as Project

const path = '/projects/fixture/.claude/worktrees/release'

const target = {
  project,
  selected: { name: 'production' },
  deploy: 'deploy',
} as CheckoutReleaseTarget

const released = {
  exitCode: 0,
  liveMatchesCandidate: true,
  alreadyLive: false,
} as ReleaseResult

function dependencies(
  calls: string[],
  overrides: Partial<ReleaseAtCommitDependencies> = {},
): ReleaseAtCommitDependencies {
  let now = 0
  return {
    resolve: (name, rung, commit) => {
      calls.push(`resolve:${name}:${rung}:${commit}`)
      return target
    },
    ensureCommit: (_project, commit) => {
      calls.push(`ensure:${commit}`)
    },
    deploy: (_target, checkout, commit) => {
      calls.push(`deploy:${checkout}:${commit}`)
      return released
    },
    id: () => 'tree-id',
    now: () => now++,
    ...overrides,
  }
}

function lifecycle(
  calls: string[],
  overrides: Partial<ReleaseTreeLifecycle> = {},
): ReleaseTreeLifecycle {
  return {
    create: (_projectPath, treeName, commit) => {
      calls.push(`create:${treeName}:${commit}`)
      return path
    },
    remove: async (checkout) => {
      calls.push(`remove:${checkout}`)
      return { outcome: 'released' }
    },
    ...overrides,
  }
}

test('releaseAtCommit provisions the requested commit, deploys from it, and removes it', async () => {
  const calls: string[] = []
  const report = await releaseAtCommit({
    project: 'fixture',
    rung: 'production',
    commit: 'merge-commit',
    lifecycle: lifecycle(calls),
    dependencies: dependencies(calls),
  })

  expect(report.result).toBe(released)
  expect(calls).toEqual([
    'resolve:fixture:production:merge-commit',
    'ensure:merge-commit',
    'create:release-production-tree-id:merge-commit',
    'deploy:/projects/fixture/.claude/worktrees/release:merge-commit',
    'remove:/projects/fixture/.claude/worktrees/release',
  ])
})

test('releaseAtCommit stops before provisioning when the commit cannot be ensured', async () => {
  const calls: string[] = []
  await expect(
    releaseAtCommit({
      project: 'fixture',
      rung: 'production',
      commit: 'absent-commit',
      lifecycle: lifecycle(calls),
      dependencies: dependencies(calls, {
        ensureCommit: () => {
          calls.push('ensure-failed')
          throw new Error('commit unavailable')
        },
      }),
    }),
  ).rejects.toThrow('commit unavailable')

  expect(calls).toEqual(['resolve:fixture:production:absent-commit', 'ensure-failed'])
})

test('releaseAtCommit removes the tree after a deploy failure', async () => {
  const calls: string[] = []
  await expect(
    releaseAtCommit({
      project: 'fixture',
      rung: 'production',
      commit: 'merge-commit',
      lifecycle: lifecycle(calls),
      dependencies: dependencies(calls, {
        deploy: () => {
          calls.push('deploy-failed')
          throw new Error('deploy failed')
        },
      }),
    }),
  ).rejects.toThrow('deploy failed')
  expect(calls.at(-1)).toBe('remove:/projects/fixture/.claude/worktrees/release')
})

test('releaseAtCommit preserves a proved deploy when removal leaves residue', async () => {
  const calls: string[] = []
  const report = await releaseAtCommit({
    project: 'fixture',
    rung: 'production',
    commit: 'merge-commit',
    lifecycle: lifecycle(calls, {
      remove: async () => ({ outcome: 'kept', reason: 'untracked build output remains' }),
    }),
    dependencies: dependencies(calls),
  })

  expect(report.result.liveMatchesCandidate).toBe(true)
  expect(report.residue).toBe('untracked build output remains')
})

function commitRunner(
  calls: string[],
  checks: boolean[],
  fetchFailure?: Error,
): Parameters<typeof ensureCommitWithGit>[2] {
  return {
    check: (args, cwd) => {
      calls.push(`check:${cwd}:${args.join(' ')}`)
      return { ok: checks.shift() ?? false, stderr: '' }
    },
    fetch: (args, cwd) => {
      calls.push(`fetch:${cwd}:${args.join(' ')}`)
      if (fetchFailure) throw fetchFailure
    },
  }
}

test('ensureCommitWithGit does not fetch a commit already present locally', () => {
  const calls: string[] = []
  ensureCommitWithGit(project, 'local-commit', commitRunner(calls, [true]))

  expect(calls).toEqual(['check:/projects/fixture:cat-file -e local-commit^{commit}'])
})

test('ensureCommitWithGit fetches an absent commit from the landing branch', () => {
  const calls: string[] = []
  ensureCommitWithGit(project, 'merge-commit', commitRunner(calls, [false, true]))

  expect(calls).toEqual([
    'check:/projects/fixture:cat-file -e merge-commit^{commit}',
    'fetch:/projects/fixture:fetch origin main',
    'check:/projects/fixture:cat-file -e merge-commit^{commit}',
  ])
})

test('ensureCommitWithGit refuses when the commit remains absent after fetch', () => {
  expect(() =>
    ensureCommitWithGit(project, 'missing-commit', commitRunner([], [false, false])),
  ).toThrow(
    "commit missing-commit is not on origin's main after fetching in checkout /projects/fixture; run git -C /projects/fixture fetch origin main, then rerun",
  )
})

test('ensureCommitWithGit reports a fetch failure with its remedy', () => {
  expect(() =>
    ensureCommitWithGit(
      project,
      'missing-commit',
      commitRunner([], [false], new Error('network unavailable')),
    ),
  ).toThrow(
    'commit missing-commit is absent from checkout /projects/fixture; fetch failed: network unavailable; run git -C /projects/fixture fetch origin main, then rerun',
  )
})

test('ensureCommitWithGit refuses an absent commit when the project has no trunk', () => {
  const projectWithoutTrunk = { ...project, settings: { ...project.settings, trunk: undefined } }

  expect(() =>
    ensureCommitWithGit(projectWithoutTrunk, 'missing-commit', commitRunner([], [false])),
  ).toThrow('project has no trunk; set trunk, then retry')
})
