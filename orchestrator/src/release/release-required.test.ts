import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import {
  decideRequiredRungs,
  formatRequiredReleaseReport,
  type RequiredReleaseRunner,
  releaseRequiredRungs,
} from './release-required.ts'
import type { ReleaseResult } from './release-service.ts'

const project = {
  recordId: '01990000-0000-7000-8000-000000001933',
  name: 'fixture',
  path: '/fixture',
  stack: 'bun',
  canon: false,
  retiredAt: null,
  settings: {
    trunk: 'main',
    release: {
      rungs: [
        {
          name: 'hosted-api',
          branch: 'main',
          requiredWhenChanged: ['shared/record/migrations/**'],
        },
      ],
      mergeMethod: 'squash',
      requiredChecks: [],
    },
  },
} as Project

const successfulRelease = (overrides: Partial<ReleaseResult> = {}): ReleaseResult =>
  ({
    exitCode: 0,
    outputTail: 'pending 0',
    liveMatchesCandidate: true,
    alreadyLive: false,
    ...overrides,
  }) as ReleaseResult

const runner = (overrides: Partial<RequiredReleaseRunner> = {}): RequiredReleaseRunner => ({
  changedPaths: () => ['shared/record/migrations/20261031_add_column.sql'],
  prepareMain: () => {},
  newestLive: () => null,
  contains: () => false,
  release: () => successfulRelease(),
  ...overrides,
})

describe('decideRequiredRungs', () => {
  test('requires the hosted API for a record migration', () => {
    expect(
      decideRequiredRungs(
        [{ name: 'hosted-api', requiredWhenChanged: ['shared/record/migrations/**'] }],
        ['shared/record/migrations/20261031_add_column.sql'],
      ),
    ).toEqual(['hosted-api'])
  })

  test('requires no rung when no path matches', () => {
    expect(
      decideRequiredRungs(
        [{ name: 'hosted-api', requiredWhenChanged: ['shared/record/migrations/**'] }],
        ['orchestrator/src/run.ts'],
      ),
    ).toEqual([])
  })

  test('on-demand rungs remain required by a matching change', () => {
    expect(
      decideRequiredRungs(
        [{ name: 'hosted-api', onDemand: true, requiredWhenChanged: ['shared/record/**'] }],
        ['shared/record/schema.ts'],
      ),
    ).toEqual(['hosted-api'])
  })

  test('several required rungs retain declaration order', () => {
    expect(
      decideRequiredRungs(
        [
          { name: 'second', requiredWhenChanged: ['shared/**'] },
          { name: 'first', requiredWhenChanged: ['**/*.ts'] },
          { name: 'unmatched', requiredWhenChanged: ['docs/**'] },
        ],
        ['shared/record/schema.ts'],
      ),
    ).toEqual(['second', 'first'])
  })
})

describe('releaseRequiredRungs', () => {
  test('does not inspect changes when no rung declares required paths', () => {
    let inspected = false
    const report = releaseRequiredRungs({
      project: {
        ...project,
        settings: {
          ...project.settings,
          release: { ...project.settings.release!, rungs: [] },
        },
      },
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        changedPaths: () => {
          inspected = true
          return []
        },
      }),
    })
    expect(report).toEqual({ required: [], releases: [], satisfied: true })
    expect(inspected).toBe(false)
  })

  test('contains a changed-path failure and names every declaring rung', () => {
    const report = releaseRequiredRungs({
      project: {
        ...project,
        settings: {
          ...project.settings,
          release: {
            ...project.settings.release!,
            rungs: [
              ...project.settings.release!.rungs,
              {
                name: 'worker',
                branch: 'main',
                requiredWhenChanged: ['worker/**'],
              },
            ],
          },
        },
      },
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        changedPaths: () => {
          throw new Error('landing-branch fetch failed')
        },
      }),
    })
    expect(report).toEqual({
      required: ['hosted-api', 'worker'],
      releases: [
        expect.objectContaining({ rung: 'hosted-api', outputTail: 'landing-branch fetch failed' }),
        expect.objectContaining({ rung: 'worker', outputTail: 'landing-branch fetch failed' }),
      ],
      satisfied: false,
    })
  })

  test('releases a required rung and requires a matching live check', () => {
    const report = releaseRequiredRungs({
      project,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner(),
    })
    expect(report.satisfied).toBe(true)
    expect(report.releases).toEqual([
      {
        rung: 'hosted-api',
        deployExit: 0,
        outputTail: 'pending 0',
        satisfied: true,
        deployed: true,
      },
    ])
  })

  test('reports a failed rung with the commands that clear it', () => {
    const report = releaseRequiredRungs({
      project,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        release: () => successfulRelease({ exitCode: 7, outputTail: 'pending 1' }),
      }),
    })
    expect(report.satisfied).toBe(false)
    const output = formatRequiredReleaseReport(report, '42', project.name)
    expect(output).toContain('required rung hosted-api: deploy exit 7; pending 1')
    expect(output).toContain(`${PLATFORM_SLUG} pr merge 42 --release-required`)
    expect(output).toContain(`${PLATFORM_SLUG} release run fixture --rung hosted-api`)
  })

  test('does not deploy a required rung when the flag is absent', () => {
    let deployed = false
    const report = releaseRequiredRungs({
      project,
      mergeCommit: 'merge',
      releaseRequired: false,
      runner: runner({
        release: () => {
          deployed = true
          return successfulRelease()
        },
      }),
    })
    expect(report.satisfied).toBe(false)
    expect(report.releases[0]?.deployExit).toBeNull()
    expect(deployed).toBe(false)
  })

  test('reports a dirty or wrong-branch main checkout without deploying', () => {
    const report = releaseRequiredRungs({
      project,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        prepareMain: () => {
          throw new Error('registered main checkout is dirty; clean it')
        },
      }),
    })
    expect(report.satisfied).toBe(false)
    expect(report.releases[0]?.outputTail).toBe('registered main checkout is dirty; clean it')
    expect(formatRequiredReleaseReport(report, '42', project.name)).toContain(
      `${PLATFORM_SLUG} pr merge 42 --release-required`,
    )
  })

  test('skips a rung already live at a commit containing the merge', () => {
    let deployed = false
    const report = releaseRequiredRungs({
      project,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        newestLive: () => 'newer',
        contains: (_project, ancestor, descendant) =>
          ancestor === 'merge' && descendant === 'newer',
        release: () => {
          deployed = true
          return successfulRelease()
        },
      }),
    })
    expect(report.satisfied).toBe(true)
    expect(report.releases[0]).toMatchObject({
      deployed: false,
      outputTail: 'already live at newer',
    })
    expect(deployed).toBe(false)
  })

  test('deploys when the newest live release does not contain the merge', () => {
    let deployed = false
    const report = releaseRequiredRungs({
      project,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        newestLive: () => 'older',
        contains: () => false,
        release: () => {
          deployed = true
          return successfulRelease()
        },
      }),
    })
    expect(report.satisfied).toBe(true)
    expect(report.releases[0]?.deployed).toBe(true)
    expect(deployed).toBe(true)
  })

  test('a failed required rung is retried and may then succeed', () => {
    let attempts = 0
    const retrying = runner({
      release: () => {
        attempts++
        return successfulRelease(
          attempts === 1 ? { exitCode: 1, outputTail: 'failed', liveMatchesCandidate: null } : {},
        )
      },
    })
    expect(
      releaseRequiredRungs({
        project,
        mergeCommit: 'merge',
        releaseRequired: true,
        runner: retrying,
      }).satisfied,
    ).toBe(false)
    expect(
      releaseRequiredRungs({
        project,
        mergeCommit: 'merge',
        releaseRequired: true,
        runner: retrying,
      }).satisfied,
    ).toBe(true)
    expect(attempts).toBe(2)
  })
})
