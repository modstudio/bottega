import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import { releaseProofDecision } from './release-decision.ts'
import {
  formatRequiredReleaseReport,
  type IncomingRequiredRungDependencies,
  incomingRequiredRungGuard,
  machineUpdateRungRefusal,
  type RequiredReleaseRung,
  type RequiredReleaseRunner,
  releaseRequiredFlagAbsent,
  releaseRequiredRungsAfterMainMove,
  releaseRequiredRungsBeforeMainMove,
  requiredReleaseStepOrder,
  requiredRungDecision,
  undecidedRequiredRelease,
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
    worktree: { recipePath: `${PLATFORM_SLUG}.jsonc` },
    release: {
      rungs: [
        {
          name: 'hosted-api',
          branch: 'main',
          deploy: 'deploy hosted-api',
          live: 'read hosted-api live commit',
          requiredWhenChanged: ['shared/record/migrations/**'],
        },
      ],
      mergeMethod: 'squash',
      requiredChecks: [],
    },
  },
} as Project

test.each(['alephbeis', 'starship'])(
  '%s production uses CI live-wait after the main checkout moves',
  (name) => {
    const production: RequiredReleaseRung = {
      name: 'production',
      branch: 'master',
      live: 'read production commit',
      onDemand: false,
    }
    const registered = {
      ...project,
      name,
      settings: {
        ...project.settings,
        trunk: 'master',
        release: { ...project.settings.release!, rungs: [production] },
      },
    } as Project
    const plan = {
      rung: 'production',
      branch: 'master',
      required: true,
      requiredBy: 'explicit' as const,
      reason: null,
      declaresLive: true,
      declaresDeploy: false,
      canDeployFromTree: false,
    }
    let childReleased = false

    expect(requiredReleaseStepOrder(true, [plan])).toEqual(['move-main', 'hand-off'])
    expect(
      releaseRequiredRungsAfterMainMove({
        project: registered,
        mergeCommit: 'merge',
        rungs: [plan],
        runner: runner({
          release: () => {
            childReleased = true
            return successfulRelease()
          },
        }),
      }).satisfied,
    ).toBe(true)
    expect(childReleased).toBe(true)
  },
)

test('machine update refuses an incoming commit until every required rung proves it live', () => {
  const input = {
    incomingCommit: 'incoming-tip',
    requiredRungs: ['hosted-api'],
    provedCommits: new Map([['hosted-api', 'live-tip']]),
    liveIsAncestorOfIncoming: new Map([['hosted-api', false]]),
    requiredSinceLive: new Map([['hosted-api', true]]),
    project: 'fixture',
  }
  expect(
    machineUpdateRungRefusal({ ...input, liveContainsIncoming: new Map([['hosted-api', false]]) }),
  ).toContain(`${PLATFORM_SLUG} release run fixture --rung hosted-api --at incoming-tip`)
  expect(
    machineUpdateRungRefusal({ ...input, liveContainsIncoming: new Map([['hosted-api', true]]) }),
  ).toBeNull()
})

test('machine update accepts unrelated commits after the newest proved release', () => {
  expect(
    machineUpdateRungRefusal({
      incomingCommit: 'unrelated-y',
      requiredRungs: ['hosted-api'],
      provedCommits: new Map([['hosted-api', 'released-x']]),
      liveContainsIncoming: new Map([['hosted-api', false]]),
      liveIsAncestorOfIncoming: new Map([['hosted-api', true]]),
      requiredSinceLive: new Map([['hosted-api', false]]),
      project: 'fixture',
    }),
  ).toBeNull()
})

test('machine update derives the X-then-unrelated-Y allowance from required rung settings', () => {
  const guarded = {
    ...project,
    settings: {
      ...project.settings,
      release: {
        ...project.settings.release!,
        rungs: [
          {
            name: 'hosted-api',
            branch: 'main',
            deploy: 'deploy hosted-api',
            live: 'read hosted-api live commit',
            requiredWhenChanged: ['shared/record/**'],
            entryPoints: ['orchestrator/src/record/server.ts'],
          },
          {
            name: 'reach-only',
            branch: 'main',
            deploy: 'deploy reach-only',
            live: 'read reach-only live commit',
          },
        ],
      },
    },
  } as Project
  let now = 0
  let closureReads = 0
  const dependencies: IncomingRequiredRungDependencies = {
    resolve: (ref) => (ref === 'HEAD' ? 'before-x' : 'unrelated-y'),
    changedPaths: (_project, from) =>
      from === 'before-x' ? ['shared/record/schema.ts', 'docs/guide.md'] : ['docs/guide.md'],
    entryClosure: () => {
      closureReads++
      return new Map()
    },
    newestLive: (_project, rung) => (rung === 'hosted-api' ? 'released-x' : null),
    contains: (_project, ancestor, descendant) =>
      ancestor === 'released-x' && descendant === 'unrelated-y',
    now: () => now++,
  }

  expect(incomingRequiredRungGuard(guarded, 'main', dependencies)).toEqual({
    refusal: null,
    elapsedMs: 1,
  })
  expect(closureReads).toBe(1)
})

const successfulRelease = (overrides: Partial<ReleaseResult> = {}): ReleaseResult =>
  ({
    exitCode: 0,
    outputTail: 'pending 0',
    liveMatchesCandidate: true,
    alreadyLive: false,
    ...overrides,
  }) as ReleaseResult

const runner = (overrides: Partial<RequiredReleaseRunner> = {}): RequiredReleaseRunner => ({
  newestLive: () => null,
  contains: () => false,
  release: () => successfulRelease(),
  ...overrides,
})

describe('requiredRungDecision', () => {
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

  test('reaches an unconditioned rung when a changed path is outside its entry closure', () => {
    const decision = requiredRungDecision(
      entryPointProject,
      () => ['docs/release.md'],
      () =>
        new Map([
          ['orchestrator/src/record/server.ts', new Set(['orchestrator/src/record/server.ts'])],
        ]),
    )

    expect(decision.required).toEqual(['hosted-api'])
  })

  test('marks a rung explicitly required when only its entry closure matches', () => {
    const decision = requiredRungDecision(
      {
        ...entryPointProject,
        settings: {
          ...entryPointProject.settings,
          release: {
            ...entryPointProject.settings.release!,
            rungs: [
              {
                name: 'hosted-hub',
                branch: 'main',
                requiredWhenChanged: ['hub/migrations/**'],
                entryPoints: ['hub/src/hosted.ts'],
              },
            ],
          },
        },
      },
      () => ['shared/call-budgets.ts'],
      () =>
        new Map([['hub/src/hosted.ts', new Set(['hub/src/hosted.ts', 'shared/call-budgets.ts'])]]),
    )

    expect(decision.rungs).toEqual([
      expect.objectContaining({
        rung: 'hosted-hub',
        required: true,
        requiredBy: 'explicit',
      }),
    ])
  })

  test('does not inspect changes when no rung declares required paths', () => {
    let inspected = false
    const decision = requiredRungDecision(
      {
        ...project,
        settings: {
          ...project.settings,
          release: { ...project.settings.release!, rungs: [] },
        },
      },
      () => {
        inspected = true
        return []
      },
      () => new Map(),
    )

    expect(decision).toEqual({ decided: true, required: [], rungs: [], error: null })
    expect(inspected).toBe(false)
  })

  test('does not read entry closures when no rung declares entry points', () => {
    let readClosure = false
    requiredRungDecision(
      project,
      () => ['shared/record/migrations/20261031_add_column.sql'],
      () => {
        readClosure = true
        return new Map()
      },
    )

    expect(readClosure).toBe(false)
  })

  test('an entry closure failure leaves every rung undecided', () => {
    const decision = requiredRungDecision(
      {
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
      () => ['shared/record/migrations/20261031_add_column.sql'],
      () => {
        throw new Error('entry closure unavailable')
      },
    )

    expect(decision).toMatchObject({
      decided: false,
      required: [],
      error: 'entry closure unavailable',
    })
    expect(decision.rungs).toEqual([
      expect.objectContaining({
        rung: 'hosted-api',
        required: false,
        reason: 'requirement could not be decided: entry closure unavailable',
      }),
      expect.objectContaining({
        rung: 'hosted-hub',
        required: false,
        reason: 'requirement could not be decided: entry closure unavailable',
      }),
    ])
  })

  test('contains a changed-path failure without naming any rung as required', () => {
    const decision = requiredRungDecision(
      {
        ...project,
        settings: {
          ...project.settings,
          release: {
            ...project.settings.release!,
            rungs: [
              ...project.settings.release!.rungs,
              { name: 'worker', branch: 'main', requiredWhenChanged: ['worker/**'] },
            ],
          },
        },
      },
      () => {
        throw new Error('landing-branch fetch failed')
      },
      () => new Map(),
    )

    expect(decision).toMatchObject({
      decided: false,
      required: [],
      error: 'landing-branch fetch failed',
    })
    if (decision.decided) throw new Error('expected an undecided release requirement')
    const report = undecidedRequiredRelease(decision.rungs, decision.error)
    expect(report.satisfied).toBe(false)
    expect(formatRequiredReleaseReport(report, '42', project.name)).toBe(
      `release not proven: requirement could not be decided: landing-branch fetch failed; retry: ${PLATFORM_SLUG} pr merge 42 --release-required`,
    )
  })

  test('satisfies and explains a reach-only rung when the flag is absent', () => {
    const reachOnlyProject = {
      ...project,
      settings: {
        ...project.settings,
        release: {
          ...project.settings.release!,
          rungs: [{ name: 'npm', branch: 'main', releasesWhenChanged: ['packages/**'] }],
        },
      },
    } as Project
    const decision = requiredRungDecision(
      reachOnlyProject,
      () => ['packages/core/CHANGELOG.md'],
      () => new Map(),
    )
    const report = releaseRequiredFlagAbsent(decision.rungs)

    expect(report.required).toEqual([])
    expect(report.satisfied).toBe(true)
    expect(report.releases).toEqual([
      expect.objectContaining({
        rung: 'npm',
        required: false,
        satisfied: true,
        outputTail: 'ship-to reach deploys only at production with --release-required',
      }),
    ])
  })

  test('a path-inspection failure remains unsatisfied when the flag is absent', () => {
    const reachOnlyProject = {
      ...project,
      settings: {
        ...project.settings,
        release: {
          ...project.settings.release!,
          rungs: [{ name: 'npm', branch: 'main', releasesWhenChanged: ['packages/**'] }],
        },
      },
    } as Project
    const decision = requiredRungDecision(
      reachOnlyProject,
      () => {
        throw new Error('changed paths unavailable')
      },
      () => new Map(),
    )
    const report = undecidedRequiredRelease(decision.rungs, 'changed paths unavailable')

    expect(report.required).toEqual([])
    expect(report.satisfied).toBe(false)
    expect(report.releases[0]?.outputTail).toBe(
      'requirement could not be decided: changed paths unavailable',
    )
  })

  test('deploys rungs matched explicitly and by reach with the flag', () => {
    let deployed = 0
    const bothProject = {
      ...project,
      settings: {
        ...project.settings,
        release: {
          ...project.settings.release!,
          rungs: [
            {
              name: 'explicit',
              branch: 'main',
              deploy: 'deploy explicit',
              live: 'read explicit live commit',
              requiredWhenChanged: ['packages/**'],
            },
            {
              name: 'reach',
              branch: 'main',
              deploy: 'deploy reach',
              live: 'read reach live commit',
              releasesWhenChanged: ['packages/**'],
            },
          ],
        },
      },
    } as Project
    const decision = requiredRungDecision(
      bothProject,
      () => ['packages/core/CHANGELOG.md'],
      () => new Map(),
    )

    expect(decision.required).toEqual(['explicit', 'reach'])
    expect(decision.rungs).toEqual([
      expect.objectContaining({ rung: 'explicit', required: true, requiredBy: 'explicit' }),
      expect.objectContaining({ rung: 'reach', required: true, requiredBy: 'reach' }),
    ])

    const report = releaseRequiredRungsAfterMainMove({
      project: bothProject,
      mergeCommit: 'merge',
      rungs: decision.rungs,
      runner: runner({
        release: () => {
          deployed++
          return successfulRelease()
        },
      }),
    })

    expect(report.required).toEqual(['explicit', 'reach'])
    expect(report.satisfied).toBe(true)
    expect(deployed).toBe(2)
  })

  test('defers a reached non-landing production rung to promote-release', () => {
    let releases = 0
    const productionProject = {
      ...project,
      settings: {
        ...project.settings,
        trunk: 'develop',
        release: {
          ...project.settings.release!,
          rungs: [{ name: 'production', branch: 'master' }],
        },
      },
    } as Project
    const decision = requiredRungDecision(
      productionProject,
      () => ['src/app.ts'],
      () => new Map(),
    )
    const report = releaseRequiredRungsAfterMainMove({
      project: productionProject,
      mergeCommit: 'merge',
      rungs: decision.rungs,
      runner: runner({
        release: () => {
          releases++
          return successfulRelease()
        },
      }),
    })

    expect(decision.required).toEqual([])
    expect(decision.rungs).toEqual([
      expect.objectContaining({
        rung: 'production',
        branch: 'master',
        required: false,
        reason:
          'proved at promote-release: rung production deploys from master, not the landing branch develop',
      }),
    ])
    expect(report).toEqual({
      required: [],
      releases: [
        {
          rung: 'production',
          required: false,
          deployExit: null,
          outputTail:
            'proved at promote-release: rung production deploys from master, not the landing branch develop',
          satisfied: true,
          deployed: false,
        },
      ],
      satisfied: true,
    })
    expect(releases).toBe(0)
  })

  test('still requires a reached rung on the landing branch', () => {
    const landingProject = {
      ...project,
      settings: {
        ...project.settings,
        trunk: 'develop',
        release: {
          ...project.settings.release!,
          rungs: [{ name: 'production', branch: 'develop', deploy: 'deploy production' }],
        },
      },
    } as Project

    const decision = requiredRungDecision(
      landingProject,
      () => ['src/app.ts'],
      () => new Map(),
    )

    expect(decision.required).toEqual(['production'])
    expect(decision.rungs).toEqual([
      expect.objectContaining({ rung: 'production', branch: 'develop', required: true }),
    ])
  })
})

test('machine update refuses an unproved rung matched only through its entry closure', () => {
  const guarded = {
    ...project,
    settings: {
      ...project.settings,
      release: {
        ...project.settings.release!,
        rungs: [
          {
            name: 'hosted-hub',
            branch: 'main',
            deploy: 'deploy hosted-hub',
            live: 'read hosted-hub live commit',
            requiredWhenChanged: ['hub/migrations/**'],
            entryPoints: ['hub/src/hosted.ts'],
          },
        ],
      },
    },
  } as Project
  let now = 0
  const dependencies: IncomingRequiredRungDependencies = {
    resolve: (ref) => (ref === 'HEAD' ? 'current' : 'incoming'),
    changedPaths: () => ['shared/call-budgets.ts'],
    entryClosure: () =>
      new Map([['hub/src/hosted.ts', new Set(['hub/src/hosted.ts', 'shared/call-budgets.ts'])]]),
    newestLive: () => null,
    contains: () => false,
    now: () => now++,
  }

  expect(incomingRequiredRungGuard(guarded, 'main', dependencies).refusal).toContain(
    'required rung hosted-hub has not proved incoming commit incoming live',
  )
})

describe('releaseRequiredRungsBeforeMainMove', () => {
  const plan = (rung: string, canDeployFromTree: boolean) => ({
    rung,
    branch: 'main',
    required: true,
    requiredBy: 'explicit' as const,
    reason: null,
    declaresLive: true,
    declaresDeploy: true,
    canDeployFromTree,
  })

  test('deploys only required rungs that can release from a tracked tree', async () => {
    const deployed: string[] = []
    const report = await releaseRequiredRungsBeforeMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [plan('hosted-api', true), plan('other', false)],
      releaseAt: async ({ rung }) => {
        deployed.push(rung)
        return {
          result: successfulRelease(),
          provisionMs: 1,
          deployMs: 2,
          releaseMs: 3,
        }
      },
      now: () => new Date('2026-11-22T20:00:00.000Z'),
    })

    expect(deployed).toEqual(['hosted-api'])
    expect(report.required).toEqual(['hosted-api'])
    expect(report.satisfied).toBe(true)
  })

  test('scores an unproved deploy unsatisfied and names teardown residue', async () => {
    const report = await releaseRequiredRungsBeforeMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [plan('hosted-api', true)],
      releaseAt: async () => ({
        result: successfulRelease({
          exitCode: 7,
          liveMatchesCandidate: false,
          outputTail: 'deploy failed',
        }),
        provisionMs: 1,
        deployMs: 2,
        releaseMs: 3,
        residue: 'release tree kept',
      }),
    })

    expect(report.satisfied).toBe(false)
    expect(report.releases[0]?.outputTail).toContain('deploy failed')
    expect(report.releases[0]?.outputTail).toContain('release checkout residue: release tree kept')
  })

  test('keeps a proved deploy satisfied while naming teardown residue', async () => {
    const report = await releaseRequiredRungsBeforeMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [plan('hosted-api', true)],
      releaseAt: async () => ({
        result: successfulRelease(),
        provisionMs: 1,
        deployMs: 2,
        releaseMs: 3,
        residue: 'release tree kept',
      }),
      now: () => new Date('2026-11-22T20:00:00.000Z'),
    })

    expect(report.satisfied).toBe(true)
    expect(report.releases[0]?.outputTail).toContain('release checkout residue: release tree kept')
  })
})

describe('releaseRequiredRungsAfterMainMove', () => {
  const requiredPlan = {
    rung: 'hosted-api',
    branch: 'main',
    required: true,
    requiredBy: 'explicit' as const,
    reason: null,
    declaresLive: true,
    declaresDeploy: true,
    canDeployFromTree: true,
  }

  test('releases required rungs after the main checkout move', () => {
    let released = false
    const report = releaseRequiredRungsAfterMainMove({
      project,
      mergeCommit: 'merge',
      rungs: [requiredPlan],
      runner: runner({
        release: () => {
          released = true
          return successfulRelease()
        },
      }),
    })

    expect(report.satisfied).toBe(true)
    expect(released).toBe(true)
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

  test('skips a live-proved rung whose candidate contains the merge', () => {
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
      outputTail: 'already live at newer',
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

  test('a landing-branch rung without deploy or live reports only the register remedy', () => {
    let released = false
    const unprovableProject = {
      ...project,
      settings: {
        ...project.settings,
        release: {
          ...project.settings.release!,
          rungs: [{ name: 'production', branch: 'main' }],
        },
      },
    } as Project
    const report = releaseRequiredRungsAfterMainMove({
      project: unprovableProject,
      mergeCommit: 'merge',
      rungs: [
        {
          rung: 'production',
          branch: 'main',
          required: true,
          requiredBy: 'reach',
          reason: null,
          declaresLive: false,
          declaresDeploy: false,
        },
      ],
      runner: runner({
        release: () => {
          released = true
          return successfulRelease()
        },
      }),
    })
    const output = formatRequiredReleaseReport(report, '42', unprovableProject.name)

    expect(report.satisfied).toBe(false)
    expect(output).toContain(
      `${PLATFORM_SLUG} project set fixture --settings '{"release":{"rungs":[{"name":"production","branch":"main","live":"<command that prints the deployed commit sha>"}]}}'`,
    )
    expect(output).not.toContain(`${PLATFORM_SLUG} pr merge`)
    expect(released).toBe(false)
  })

  test('a deploy-only rung is refused before release with the complete register remedy', () => {
    let released = false
    const deployOnlyProject = {
      ...project,
      settings: {
        ...project.settings,
        release: {
          ...project.settings.release!,
          rungs: [{ name: 'production', branch: 'main', deploy: 'dispatch production' }],
        },
      },
    } as Project
    const report = releaseRequiredRungsAfterMainMove({
      project: deployOnlyProject,
      mergeCommit: 'merge',
      rungs: [
        {
          rung: 'production',
          branch: 'main',
          required: true,
          requiredBy: 'reach',
          reason: null,
          declaresLive: false,
          declaresDeploy: true,
        },
      ],
      runner: runner({
        release: () => {
          released = true
          return successfulRelease()
        },
      }),
    })

    expect(report.satisfied).toBe(false)
    expect(report.releases[0]?.outputTail).toContain(
      `${PLATFORM_SLUG} project set fixture --settings '{"release":{"rungs":[{"name":"production","branch":"main","deploy":"dispatch production","live":"<command that prints the deployed commit sha>"}]}}'`,
    )
    expect(report.releases[0]?.outputTail).toContain(
      'prints the commit the running deployment was built from, not a reachability check',
    )
    expect(released).toBe(false)
  })

  test('an unprovable rung does not suppress another failed rung remedy', () => {
    const mixedProject = {
      ...project,
      settings: {
        ...project.settings,
        release: {
          ...project.settings.release!,
          rungs: [
            { name: 'unprovable', branch: 'main' },
            {
              name: 'failed',
              branch: 'main',
              deploy: 'deploy failed',
              live: 'read failed live commit',
            },
          ],
        },
      },
    } as Project
    const report = releaseRequiredRungsAfterMainMove({
      project: mixedProject,
      mergeCommit: 'merge',
      rungs: [
        {
          rung: 'unprovable',
          branch: 'main',
          required: true,
          requiredBy: 'reach',
          reason: null,
          declaresLive: false,
          declaresDeploy: false,
        },
        {
          ...requiredPlan,
          rung: 'failed',
        },
      ],
      runner: runner({
        release: () => successfulRelease({ exitCode: 7, outputTail: 'deploy failed' }),
      }),
    })

    const output = formatRequiredReleaseReport(report, '42', mixedProject.name)
    expect(output).toContain(`${PLATFORM_SLUG} release run fixture --rung failed`)
    expect(output).not.toContain(`${PLATFORM_SLUG} release run fixture --rung unprovable`)
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
            {
              name: 'artifact-match',
              branch: 'main',
              deploy: 'deploy artifact-match',
              releasesWhenChanged: ['packages/**'],
            },
            { name: 'artifact-skip', branch: 'main', releasesWhenChanged: ['docs/**'] },
            { name: 'unconditioned', branch: 'main', deploy: 'deploy unconditioned' },
            {
              name: 'demand-match',
              branch: 'main',
              deploy: 'deploy demand-match',
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
    const decision = requiredRungDecision(
      guardedProject,
      () => ['packages/core/CHANGELOG.md'],
      () => new Map(),
      'unconditioned',
    )
    const report = releaseRequiredRungsAfterMainMove({
      project: guardedProject,
      mergeCommit: 'merge',
      rungs: decision.rungs,
      runner: runner(),
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
  test('does not prove a no-live rung from a successful descendant release', () => {
    expect(
      releaseProofDecision({
        exitCode: 0,
        liveMatchesCandidate: null,
        candidateContainsMerge: true,
      }),
    ).toBe(false)
  })

  test('does not prove a live rung from a null match', () => {
    expect(
      releaseProofDecision({
        exitCode: 0,
        liveMatchesCandidate: null,
        candidateContainsMerge: true,
      }),
    ).toBe(false)
  })

  test('proves a live rung from a matching descendant release', () => {
    expect(
      releaseProofDecision({
        exitCode: 0,
        liveMatchesCandidate: true,
        candidateContainsMerge: true,
      }),
    ).toBe(true)
  })
})
