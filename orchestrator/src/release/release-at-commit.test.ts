import { expect, test } from 'bun:test'
import type { Project } from '../project/projects.ts'
import {
  type ReleaseAtCommitDependencies,
  releaseAtCommit,
  type ReleaseTreeLifecycle,
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
    'create:release-production-tree-id:merge-commit',
    'deploy:/projects/fixture/.claude/worktrees/release:merge-commit',
    'remove:/projects/fixture/.claude/worktrees/release',
  ])
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
