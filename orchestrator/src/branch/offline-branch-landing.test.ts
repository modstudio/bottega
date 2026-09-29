import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addProject,
  git,
  gitRepository,
  removeGitRepository,
} from '../../test/fixtures/offline-branch-landing.ts'
import { offlineBranchLandingObservations } from './offline-branch-landing.ts'

test('offline landing observation does not write Git objects', () => {
  const path = gitRepository('readonly')
  try {
    git(path, 'checkout', '-b', 'candidate')
    writeFileSync(join(path, 'state.txt'), 'middle\n')
    git(path, 'commit', '-am', 'middle')
    writeFileSync(join(path, 'state.txt'), 'landed\n')
    git(path, 'commit', '-am', 'landed')
    git(path, 'checkout', 'main')
    writeFileSync(join(path, 'state.txt'), 'landed\n')
    git(path, 'commit', '-am', 'squashed candidate')
    const projectId = addProject('readonly', path)
    const before = git(path, 'count-objects', '-v')

    expect(
      offlineBranchLandingObservations([{ projectId, project: 'readonly', branch: 'candidate' }]),
    ).toEqual([
      { projectId, project: 'readonly', branch: 'candidate', branchExists: true, landed: false },
    ])
    expect(git(path, 'count-objects', '-v')).toBe(before)
  } finally {
    removeGitRepository(path)
  }
})
