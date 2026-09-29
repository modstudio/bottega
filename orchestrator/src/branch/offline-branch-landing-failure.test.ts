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

test('one branch classification failure does not hide an absent sibling', () => {
  const path = gitRepository('failure')
  try {
    const tree = git(path, 'rev-parse', 'main^{tree}')
    const malformedCommit = join(path, 'malformed-commit')
    writeFileSync(
      malformedCommit,
      `tree ${tree}\nparent ${'0'.repeat(40)}\nauthor Fixture <fixture@example.com> 0 +0000\ncommitter Fixture <fixture@example.com> 0 +0000\n\nunrelated history\n`,
    )
    const unrelated = git(path, 'hash-object', '-t', 'commit', '-w', malformedCommit)
    git(path, 'update-ref', 'refs/heads/unrelated', unrelated)
    const projectId = addProject('failure', path)

    expect(
      offlineBranchLandingObservations([
        { projectId, project: 'failure', branch: 'unrelated' },
        { projectId, project: 'failure', branch: 'deleted' },
      ]),
    ).toEqual([
      { projectId, project: 'failure', branch: 'deleted', branchExists: false, landed: false },
    ])
  } finally {
    removeGitRepository(path)
  }
})
