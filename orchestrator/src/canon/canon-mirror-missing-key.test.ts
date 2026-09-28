import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { upsertProject } from '../project/projects.ts'
import { mirrorRepositoryCanon } from './canon-mirror.ts'
import { canonMirrorFixtureRepository } from './canon-mirror-fixture.ts'

test('a managed project without a standing key is skipped as a failure', async () => {
  const root = canonMirrorFixtureRepository('canon-mirror-missing-key')
  try {
    upsertProject({
      name: 'canon-mirror-missing-key',
      path: root,
      canon: true,
      settings: { managedContext: true, trunk: 'main' },
    })
    const results = await mirrorRepositoryCanon({
      project: 'canon-mirror-missing-key',
      dryRun: true,
    })
    expect(results).toEqual([
      expect.objectContaining({ failed: true, text: expect.stringContaining('canonMirrorKey') }),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
