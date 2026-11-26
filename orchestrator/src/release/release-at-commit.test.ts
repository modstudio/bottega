import { expect, test } from 'bun:test'
import { BoundExceededError } from '../../../shared/call-budgets.ts'
import type { GitRefObservation } from '../git/git-environment.ts'
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
  selected: { name: 'production', branch: 'production' },
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
    ensureCommit: (_project, commit, rungBranch) => {
      calls.push(`ensure:${commit}:${rungBranch}`)
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
    'ensure:merge-commit:production',
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
  observations: GitRefObservation[],
  fetchFailure?: (branch: string) => unknown,
): Parameters<typeof ensureCommitWithGit>[3] {
  return {
    observe: (cwd, ref) => {
      calls.push(`observe:${cwd}:${ref}`)
      return observations.shift() ?? { outcome: 'absent' }
    },
    fetch: (args, cwd) => {
      calls.push(`fetch:${cwd}:${args.join(' ')}`)
      const failure = fetchFailure?.(args[2]!)
      if (failure) throw failure
    },
  }
}

test('ensureCommitWithGit does not fetch a commit already present locally', () => {
  const calls: string[] = []
  ensureCommitWithGit(
    project,
    'local-commit',
    'production',
    commitRunner(calls, [{ outcome: 'present' }]),
  )

  expect(calls).toEqual(['observe:/projects/fixture:local-commit^{commit}'])
})

test('ensureCommitWithGit fetches an absent commit from the landing branch', () => {
  const calls: string[] = []
  ensureCommitWithGit(
    project,
    'merge-commit',
    'main',
    commitRunner(calls, [{ outcome: 'absent' }, { outcome: 'present' }]),
  )

  expect(calls).toEqual([
    'observe:/projects/fixture:merge-commit^{commit}',
    'fetch:/projects/fixture:fetch origin main',
    'observe:/projects/fixture:merge-commit^{commit}',
  ])
})

test('ensureCommitWithGit fetches the landing and non-landing rung branches', () => {
  const calls: string[] = []
  ensureCommitWithGit(
    project,
    'release-commit',
    'production',
    commitRunner(calls, [{ outcome: 'absent' }, { outcome: 'present' }]),
  )

  expect(calls).toEqual([
    'observe:/projects/fixture:release-commit^{commit}',
    'fetch:/projects/fixture:fetch origin main',
    'fetch:/projects/fixture:fetch origin production',
    'observe:/projects/fixture:release-commit^{commit}',
  ])
})

test('ensureCommitWithGit refuses when the commit remains absent from both branches', () => {
  expect(() =>
    ensureCommitWithGit(
      project,
      'missing-commit',
      'production',
      commitRunner([], [{ outcome: 'absent' }, { outcome: 'absent' }]),
    ),
  ).toThrow(
    "commit missing-commit is not on origin's main or production after fetching in checkout /projects/fixture; run git -C /projects/fixture fetch origin main production, then rerun",
  )
})

test('ensureCommitWithGit refuses a failed probe without fetching', () => {
  const calls: string[] = []
  expect(() =>
    ensureCommitWithGit(
      project,
      'missing-commit',
      'production',
      commitRunner(calls, [{ outcome: 'failed', detail: 'not a git repository' }]),
    ),
  ).toThrow(
    'could not verify commit missing-commit in checkout /projects/fixture: not a git repository',
  )
  expect(calls).toEqual(['observe:/projects/fixture:missing-commit^{commit}'])
})

test('ensureCommitWithGit reports the failed branch fetch with its remedy', () => {
  expect(() =>
    ensureCommitWithGit(
      project,
      'missing-commit',
      'production',
      commitRunner([], [{ outcome: 'absent' }], (branch) =>
        branch === 'production' ? new Error('network unavailable') : undefined,
      ),
    ),
  ).toThrow(
    "commit missing-commit is absent from checkout /projects/fixture; fetch of origin's production failed: network unavailable; run git -C /projects/fixture fetch origin main production, then rerun",
  )
})

test('ensureCommitWithGit propagates a fetch bound error unchanged', () => {
  const bound = new BoundExceededError('git fetch origin main', 'git-network', 'deadline', 120_000)
  expect(() =>
    ensureCommitWithGit(
      project,
      'missing-commit',
      'main',
      commitRunner([], [{ outcome: 'absent' }], () => bound),
    ),
  ).toThrow(bound)
})

test('ensureCommitWithGit reports a failed probe after fetching', () => {
  expect(() =>
    ensureCommitWithGit(
      project,
      'missing-commit',
      'main',
      commitRunner(
        [],
        [{ outcome: 'absent' }, { outcome: 'failed', detail: 'object database unreadable' }],
      ),
    ),
  ).toThrow(
    'could not verify commit missing-commit in checkout /projects/fixture after fetching: object database unreadable',
  )
})

test('ensureCommitWithGit refuses an absent commit when the project has no trunk', () => {
  const projectWithoutTrunk = { ...project, settings: { ...project.settings, trunk: undefined } }

  expect(() =>
    ensureCommitWithGit(
      projectWithoutTrunk,
      'missing-commit',
      'production',
      commitRunner([], [{ outcome: 'absent' }]),
    ),
  ).toThrow('project has no trunk; set trunk, then retry')
})
