import { expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { mirrorFixturePort, mirrorRepository, registerManagedMirror } from './canon-mirror-ownership.fixture.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'

test('the local branch and private body file are released after a proven push failure', async () => {
  const root = mirrorRepository('cm-body-cleanup')
  let bodyFile = ''
  let branchReleased = false
  try {
    await registerManagedMirror(root, 'cm-body-cleanup')
    const base = mirrorFixturePort(root)
    const port = mirrorFixturePort(root, {
      openPullRequest: (_path, _title, file) => { bodyFile = file; throw new Error('fixture admission failure') },
      releaseBranch: (project, branch) => { branchReleased = true; base.releaseBranch(project, branch) },
    })
    const result = await mirrorRepositoryCanon({ project: 'cm-body-cleanup', dryRun: false, port, noteFailure: async () => {} })
    expect(result[0]?.text).toContain('fixture admission failure')
    expect(branchReleased).toBe(true)
    expect(existsSync(bodyFile)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
