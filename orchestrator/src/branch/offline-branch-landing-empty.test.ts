import { expect, test } from 'bun:test'
import {
  addProject,
  git,
  gitRepository,
  removeGitRepository,
} from '../../test/fixtures/offline-branch-landing.ts'
import { offlineBranchLandingObservations } from './offline-branch-landing.ts'

test('offline landing observation clears a branch with no commits off trunk', () => {
  const path = gitRepository('empty')
  try {
    git(path, 'branch', 'candidate')
    const projectId = addProject('empty', path)

    expect(
      offlineBranchLandingObservations([{ projectId, project: 'empty', branch: 'candidate' }]),
    ).toEqual([
      { projectId, project: 'empty', branch: 'candidate', branchExists: true, landed: true },
    ])
  } finally {
    removeGitRepository(path)
  }
})
