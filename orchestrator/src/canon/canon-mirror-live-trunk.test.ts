import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('the merge freshness decision reads the live remote trunk', async () => {
  const root = mirrorRepository('cm-live-trunk')
  let liveReads = 0
  try {
    await registerManagedMirror(root, 'cm-live-trunk')
    const result = await mirrorRepositoryCanon({
      project: 'cm-live-trunk',
      dryRun: false,
      port: mirrorFixturePort(root, {
        remoteTrunkTip: () => {
          liveReads += 1
          return 'moved-remote-tip'
        },
        openPullRequest: (path) => ({
          number: 10,
          url: 'https://example.test/pull/10',
          headSha: spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: path })
            .stdout.toString()
            .trim(),
          headRef: 'DEV-1002-canon-mirror',
          baseRef: 'main',
          checks: 'passed',
        }),
        releaseBranch: () => {},
      }),
      noteFailure: async () => {},
    })
    expect(liveReads).toBeGreaterThan(0)
    expect(result[0]?.text).toContain('left open')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
