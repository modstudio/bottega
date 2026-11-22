import { expect, test } from 'bun:test'
import type { Project } from '../project/projects.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  releaseAtCommit,
  type ReleaseAtCommitDependencies,
} from './release-at-commit.ts'
import type { ReleaseResult } from './release-service.ts'

const project = {
  name: 'fixture',
  path: '/projects/fixture',
  settings: { trunk: 'main' },
} as Project

const worktree: Worktree = {
  path: '/projects/fixture/.claude/worktrees/release',
  branch: '',
  base: 'merge-commit',
  repoRoot: project.path,
  source: 'git',
  mintedBranch: null,
}

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
    project: (name, rung) => {
      calls.push(`project:${name}:${rung}`)
      return project
    },
    create: (_project, treeId, commit) => {
      calls.push(`create:${treeId}:${commit}`)
      return worktree
    },
    deploy: (name, rung, path, commit) => {
      calls.push(`deploy:${name}:${rung}:${path}:${commit}`)
      return released
    },
    remove: (_tree, _project, treeId) => {
      calls.push(`remove:${treeId}`)
      return { removed: true, detail: 'removed' }
    },
    id: () => 'tree-id',
    now: () => now++,
    ...overrides,
  }
}

test('releaseAtCommit provisions the requested commit, deploys from it, and removes it', async () => {
  const calls: string[] = []
  const report = await releaseAtCommit({
    project: 'fixture',
    rung: 'production',
    commit: 'merge-commit',
    dependencies: dependencies(calls),
  })

  expect(report.result).toBe(released)
  expect(calls).toEqual([
    'project:fixture:production',
    'create:release-production-tree-id:merge-commit',
    'deploy:fixture:production:/projects/fixture/.claude/worktrees/release:merge-commit',
    'remove:release-production-tree-id',
  ])
})

test('releaseAtCommit removes the tree after a deploy failure', async () => {
  const calls: string[] = []
  await expect(
    releaseAtCommit({
      project: 'fixture',
      rung: 'production',
      commit: 'merge-commit',
      dependencies: dependencies(calls, {
        deploy: () => {
          calls.push('deploy-failed')
          throw new Error('deploy failed')
        },
      }),
    }),
  ).rejects.toThrow('deploy failed')
  expect(calls.at(-1)).toBe('remove:release-production-tree-id')
})

test('releaseAtCommit preserves a proved deploy when removal leaves residue', async () => {
  const calls: string[] = []
  const report = await releaseAtCommit({
    project: 'fixture',
    rung: 'production',
    commit: 'merge-commit',
    dependencies: dependencies(calls, {
      remove: () => ({ removed: false, detail: 'untracked build output remains' }),
    }),
  })

  expect(report.result.liveMatchesCandidate).toBe(true)
  expect(report.residue).toBe('untracked build output remains')
})
