import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import { releaseProofDecision } from './release-decision.ts'
import {
  decideRequiredRungs,
  formatRequiredReleaseReport,
  type RequiredReleaseRunner,
  releaseRequiredRungsAfterMainMove,
  requiredRungDecision,
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

describe('releaseRequiredRungsAfterMainMove', () => {
  const requiredPlan = {
    rung: 'hosted-api',
    required: true,
    requiredBy: 'explicit' as const,
    reason: null,
    declaresLive: false,
  }

  test('releases required rungs without preparing main again', () => {
    let prepared = false
    let released = false
    const report = releaseRequiredRungsAfterMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [requiredPlan],
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

  test('requires a matching live check for a released rung', () => {
    const report = releaseRequiredRungsAfterMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [requiredPlan],
      runner: runner(),
    })

    expect(report.satisfied).toBe(true)
    expect(report.releases).toEqual([
      {
        rung: 'hosted-api',
        required: true,
        deployExit: 0,
        outputTail: 'pending 0',
        satisfied: true,
        deployed: true,
      },
    ])
  })

  test('reports a failed rung with depth-preserving recovery commands', () => {
    const report = releaseRequiredRungsAfterMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [requiredPlan],
      runner: runner({
        release: () => successfulRelease({ exitCode: 7, outputTail: 'pending 1' }),
      }),
    })

    expect(report.satisfied).toBe(false)
    const output = formatRequiredReleaseReport(report, '42', project.name, 'staging')
    expect(output).toContain('required rung hosted-api: deploy exit 7; pending 1')
    expect(output).toContain(`${PLATFORM_SLUG} release run fixture --rung hosted-api`)
    expect(output.match(/--release-required --depth staging/g)).toHaveLength(2)
  })

  test('skips a no-live rung deployed at a commit containing the merge', () => {
    let deployed = false
    const report = releaseRequiredRungsAfterMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [requiredPlan],
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
      outputTail: 'deployed at newer',
    })
    expect(deployed).toBe(false)
  })

  test('deploys when the newest live release does not contain the merge', () => {
    let deployed = false
    const report = releaseRequiredRungsAfterMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [requiredPlan],
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
    const release = () =>
      releaseRequiredRungsAfterMainMove({
        project,
        mergeCommit: 'merge',
        rungs: [requiredPlan],
        runner: retrying,
      })

    expect(release().satisfied).toBe(false)
    expect(release().satisfied).toBe(true)
    expect(attempts).toBe(2)
  })
})

describe('declared-rung report class guard', () => {
  test('reports every declared rung exactly once with its outcome', () => {
    const guardedProject = {
      ...project,
      settings: {
        ...project.settings,
        release: {
          ...project.settings.release!,
          rungs: [
            { name: 'artifact-match', branch: 'main', releasesWhenChanged: ['packages/**'] },
            { name: 'artifact-skip', branch: 'main', releasesWhenChanged: ['docs/**'] },
            { name: 'unconditioned', branch: 'main' },
            {
              name: 'demand-match',
              branch: 'main',
              onDemand: true,
              requiredWhenChanged: ['packages/**'],
            },
            {
              name: 'demand-skip',
              branch: 'main',
              onDemand: true,
              requiredWhenChanged: ['infra/**'],
            },
            { name: 'beyond', branch: 'main' },
          ],
        },
      },
    } as Project
    const guardedRunner = runner({ changedPaths: () => ['packages/core/CHANGELOG.md'] })
    const decision = requiredRungDecision(
      guardedProject,
      () => guardedRunner.changedPaths(guardedProject, 'merge'),
      (entries) => guardedRunner.entryClosure(guardedProject, 'merge', entries),
      'unconditioned',
    )
    const report = releaseRequiredRungsAfterMainMove({
      project: guardedProject,
      mergeCommit: 'merge',
      rungs: decision.rungs,
      runner: guardedRunner,
    })
    const output = formatRequiredReleaseReport(report, '42', guardedProject.name)

    for (const name of [
      'artifact-match',
      'artifact-skip',
      'unconditioned',
      'demand-match',
      'demand-skip',
      'beyond',
    ]) {
      expect(output.match(new RegExp(`rung ${name}(?=[:])`, 'g'))).toHaveLength(1)
    }
    expect(output).toContain('rung artifact-skip: not required; no release artifact in this change')
    expect(output).toContain(
      'rung demand-skip: not required; no changed path matches requiredWhenChanged',
    )
    expect(output).toContain('rung beyond: not required; beyond depth unconditioned')
  })
})

describe('release proof decision', () => {
  test('proves a no-live rung from a successful descendant release', () => {
    expect(
      releaseProofDecision({
        declaresLive: false,
        exitCode: 0,
        liveMatchesCandidate: null,
        candidateContainsMerge: true,
      }),
    ).toBe(true)
  })

  test('does not prove a live rung from a null match', () => {
    expect(
      releaseProofDecision({
        declaresLive: true,
        exitCode: 0,
        liveMatchesCandidate: null,
        candidateContainsMerge: true,
      }),
    ).toBe(false)
  })

  test('proves a live rung from a matching descendant release', () => {
    expect(
      releaseProofDecision({
        declaresLive: true,
        exitCode: 0,
        liveMatchesCandidate: true,
        candidateContainsMerge: true,
      }),
    ).toBe(true)
  })
})
