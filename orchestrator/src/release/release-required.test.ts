import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import {
  decideRequiredRungs,
  formatRequiredReleaseReport,
  type RequiredReleaseRunner,
  releaseRequiredRungs,
  releaseRequiredRungsAfterMainMove,
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
  entryClosure: () => new Map(),
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
        new Map(),
      ),
    ).toEqual(['hosted-api'])
  })

  test('requires no rung when no path matches', () => {
    expect(
      decideRequiredRungs(
        [{ name: 'hosted-api', requiredWhenChanged: ['shared/record/migrations/**'] }],
        ['orchestrator/src/run.ts'],
        new Map(),
      ),
    ).toEqual([])
  })

  test('on-demand rungs remain required by a matching change', () => {
    expect(
      decideRequiredRungs(
        [{ name: 'hosted-api', onDemand: true, requiredWhenChanged: ['shared/record/**'] }],
        ['shared/record/schema.ts'],
        new Map(),
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
        new Map(),
      ),
    ).toEqual(['second', 'first'])
  })

  test('requires a rung when a changed path is in its entry closure', () => {
    const rungs = [{ name: 'hosted-api', entryPoints: ['orchestrator/src/record/server.ts'] }]
    const closure = new Map([
      [
        'orchestrator/src/record/server.ts',
        new Set(['orchestrator/src/record/server.ts', 'orchestrator/src/record/evidence.ts']),
      ],
    ])
    expect(decideRequiredRungs(rungs, ['orchestrator/src/record/evidence.ts'], closure)).toEqual([
      'hosted-api',
    ])
    expect(decideRequiredRungs(rungs, ['docs/release.md'], closure)).toEqual([])
  })
})

describe('releaseRequiredRungs', () => {
  const entryPointProject = {
    ...project,
    settings: {
      ...project.settings,
      release: {
        ...project.settings.release!,
        rungs: [
          {
            name: 'hosted-api',
            branch: 'main',
            entryPoints: ['orchestrator/src/record/server.ts'],
          },
        ],
      },
    },
  } as Project

  test('releases a rung when a changed path is in its entry closure', () => {
    let released = false
    const report = releaseRequiredRungs({
      project: entryPointProject,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        changedPaths: () => ['orchestrator/src/record/evidence.ts'],
        entryClosure: () =>
          new Map([
            [
              'orchestrator/src/record/server.ts',
              new Set(['orchestrator/src/record/server.ts', 'orchestrator/src/record/evidence.ts']),
            ],
          ]),
        release: () => {
          released = true
          return successfulRelease()
        },
      }),
    })

    expect(report.required).toEqual(['hosted-api'])
    expect(released).toBe(true)
  })

  test('does not require a rung when a changed path is outside its entry closure', () => {
    let released = false
    const report = releaseRequiredRungs({
      project: entryPointProject,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        changedPaths: () => ['docs/release.md'],
        entryClosure: () =>
          new Map([
            ['orchestrator/src/record/server.ts', new Set(['orchestrator/src/record/server.ts'])],
          ]),
        release: () => {
          released = true
          return successfulRelease()
        },
      }),
    })

    expect(report).toEqual({ required: [], releases: [], satisfied: true })
    expect(released).toBe(false)
  })

  test('uses a supplied empty decision without deriving it again', () => {
    let changedPathsRead = false
    let entryClosureRead = false
    const report = releaseRequiredRungs({
      project: entryPointProject,
      mergeCommit: 'merge',
      releaseRequired: true,
      decision: { decided: true, required: [], error: null },
      runner: runner({
        changedPaths: () => {
          changedPathsRead = true
          return []
        },
        entryClosure: () => {
          entryClosureRead = true
          return new Map()
        },
      }),
    })

    expect(report).toEqual({ required: [], releases: [], satisfied: true })
    expect(changedPathsRead).toBe(false)
    expect(entryClosureRead).toBe(false)
  })

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

  test('does not read entry closures when no rung declares entry points', () => {
    let readClosure = false
    releaseRequiredRungs({
      project,
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        entryClosure: () => {
          readClosure = true
          return new Map()
        },
      }),
    })
    expect(readClosure).toBe(false)
  })

  test('an entry closure failure requires every declaring rung', () => {
    const report = releaseRequiredRungs({
      project: {
        ...project,
        settings: {
          ...project.settings,
          release: {
            ...project.settings.release!,
            rungs: [
              ...project.settings.release!.rungs,
              { name: 'hosted-hub', branch: 'main', entryPoints: ['hub/src/hosted.ts'] },
            ],
          },
        },
      },
      mergeCommit: 'merge',
      releaseRequired: true,
      runner: runner({
        entryClosure: () => {
          throw new Error('entry closure unavailable')
        },
      }),
    })
    expect(report).toEqual({
      required: ['hosted-api', 'hosted-hub'],
      releases: [
        expect.objectContaining({ rung: 'hosted-api', outputTail: 'entry closure unavailable' }),
        expect.objectContaining({ rung: 'hosted-hub', outputTail: 'entry closure unavailable' }),
      ],
      satisfied: false,
    })
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

describe('releaseRequiredRungsAfterMainMove', () => {
  test('releases required rungs without preparing main again', () => {
    let prepared = false
    let released = false
    const report = releaseRequiredRungsAfterMainMove({
      project,
      mergeCommit: 'merge',
      required: ['hosted-api'],
      runner: runner({
        prepareMain: () => {
          prepared = true
        },
        release: () => {
          released = true
          return successfulRelease()
        },
      }),
    })

    expect(report.satisfied).toBe(true)
    expect(released).toBe(true)
    expect(prepared).toBe(false)
  })
})
