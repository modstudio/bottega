import { expect, test } from 'bun:test'
import { decideProjectLandingBranch } from './project-landing-branch.ts'

const path = '/projects/probe'

test('a supplied landing branch wins over the remote default', () => {
  expect(
    decideProjectLandingBranch({
      path,
      settings: { trunk: 'develop' },
      gitWorkTree: true,
      remoteDefaultBranch: 'main',
    }),
  ).toEqual({ kind: 'branch', trunk: 'develop', source: 'declared' })
})

test('the remote default supplies a missing landing branch', () => {
  expect(
    decideProjectLandingBranch({
      path,
      settings: {},
      gitWorkTree: true,
      remoteDefaultBranch: 'main',
    }),
  ).toEqual({ kind: 'branch', trunk: 'main', source: 'origin/HEAD' })
})

test('a git work tree without origin HEAD is refused with the exact remedy', () => {
  expect(
    decideProjectLandingBranch({
      path,
      settings: {},
      gitWorkTree: true,
      remoteDefaultBranch: null,
    }),
  ).toEqual({
    kind: 'refuse',
    reason:
      `project add refused: cannot infer the landing branch of ${path}: refs/remotes/origin/HEAD is not set; ` +
      `cleared by: git -C ${path} remote set-head origin --auto, or pass --settings '{"trunk":"<branch>"}'`,
  })
})

test('a non-git path without a landing branch is left untouched', () => {
  expect(
    decideProjectLandingBranch({
      path,
      settings: {},
      gitWorkTree: false,
      remoteDefaultBranch: null,
    }),
  ).toEqual({ kind: 'untouched' })
})
