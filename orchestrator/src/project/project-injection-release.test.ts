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

describe('release rung settings', () => {
  test.each([
    [
      { ...release.rungs[0]!, live: ' ' },
      [expect.stringContaining('release.rungs.0.live: Too small')],
    ],
    [
      {
        ...release.rungs[0]!,
        live: undefined,
        requiredWhenChanged: ['shared/record/migrations/**'],
      },
      [
        expect.stringContaining(
          'release rung "production" declares requiredWhenChanged; add a live probe or drop requiredWhenChanged',
        ),
      ],
    ],
    [{ ...release.rungs[0]!, live: undefined, releasesWhenChanged: ['src/**'] }, []],
    [
      { ...release.rungs[0]!, releasesWhenChanged: [] },
      [expect.stringContaining('release.rungs.0.releasesWhenChanged: Too small')],
    ],
    [
      { ...release.rungs[0]!, live: undefined, releasesWhenChanged: [' '] },
      [expect.stringContaining('release.rungs.0.releasesWhenChanged.0: Too small')],
    ],
  ])('validates release rung schema %#', (rung, expected) => {
    expect(validateProjectSettings({ release: { ...release, rungs: [rung] } }, 'strict')).toEqual(
      expected,
    )
  })

  test('refuses a deploy-only rung on write while allowing the existing shape on read', () => {
    const settings = {
      release: {
        ...release,
        rungs: [{ name: 'production', branch: 'production', deploy: 'bun run deploy' }],
      },
    }
    expect(validateProjectSettings(settings, 'strict')).toEqual([
      expect.stringContaining(
        'release rung "production" declares a deploy command; add a live probe that prints the commit the running deployment was built from, or drop deploy',
      ),
    ])
    expect(validateProjectSettings(settings, 'strip')).toEqual([])
  })
})
