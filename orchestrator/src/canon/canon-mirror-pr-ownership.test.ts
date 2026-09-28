import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import {
  mirrorFixturePort,
  mirrorRepository,
  registerManagedMirror,
} from './canon-mirror-ownership.fixture.ts'

test('a foreign open pull request is refused after the pushed tip is recorded', async () => {
  const root = mirrorRepository('cm-foreign-pr')
  let pushed = false
  try {
    await registerManagedMirror(root, 'cm-foreign-pr')
    const port = mirrorFixturePort(root, {
      push: () => {
        pushed = true
      },
      pullRequest: () => ({
        number: 99,
        url: 'https://example.test/pull/99',
        headSha: 'old',
        headRef: 'DEV-1002-canon-mirror',
        baseRef: 'main',
        checks: 'passed',
      }),
    })
    const result = await mirrorRepositoryCanon({
      project: 'cm-foreign-pr',
      dryRun: false,
      port,
      noteFailure: async () => {},
    })
    expect(result[0]?.text).toContain('refusing foreign pull request 99')
    expect(pushed).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
