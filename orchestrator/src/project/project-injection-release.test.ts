import { describe, expect, test } from 'bun:test'
import type { ReleaseSettings } from './project-injection.ts'
import { validateProjectSettings } from './projects.ts'

const release: ReleaseSettings = {
  rungs: [
    {
      name: 'production',
      branch: 'production',
      live: 'read live commit',
    },
  ],
  mergeMethod: 'squash',
  requiredChecks: [],
}

describe('release entry-point settings', () => {
  test.each([
    [
      { ...release.rungs[0]!, live: undefined, entryPoints: ['hub/src/hosted.ts'] },
      [
        expect.stringContaining(
          'release rung "production" declares entryPoints; add a live probe or drop entryPoints',
        ),
      ],
    ],
    [
      { ...release.rungs[0]!, entryPoints: ['hub/**', '../outside.ts'] },
      [
        expect.stringContaining('release.rungs.0.entryPoints.0: must not contain glob characters'),
        expect.stringContaining(
          'release.rungs.0.entryPoints.1: must not contain a .. path segment',
        ),
      ],
    ],
    [{ ...release.rungs[0]!, entryPoints: ['hub/src/hosted.ts'] }, []],
  ])('validates entry-point schema %#', (rung, expected) => {
    expect(validateProjectSettings({ release: { ...release, rungs: [rung] } }, 'strict')).toEqual(
      expected,
    )
  })
})
