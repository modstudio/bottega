import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import {
  type IncomingRequiredRungDependencies,
  incomingRequiredRungGuard,
  type ReleaseRungPlan,
  type RequiredReleaseRung,
  type RequiredRungDecision,
  requiredRungDecision,
} from '../release/release-required.ts'
import { adapter, cwd, recordPassingGate, registerProject } from './pr-merge.fixture.ts'
import { mergePullRequest } from './pr-merge.ts'
import {
  decidePullRequestReleaseAdmission,
  pullRequestReleaseDecisionAtHead,
} from './pr-release-admission.ts'
import { pullRequestReleaseNotice } from './pr-release-notice.ts'

function plan(rung: string, requiredBy: ReleaseRungPlan['requiredBy']): ReleaseRungPlan {
  return {
    rung,
    branch: 'main',
    required: true,
    requiredBy,
    reason: null,
    declaresLive: true,
    declaresDeploy: true,
  }
}

function decided(...rungs: ReleaseRungPlan[]): RequiredRungDecision {
  return {
    decided: true,
    required: rungs.map(({ rung }) => rung),
    rungs,
    error: null,
  }
}

describe('decidePullRequestReleaseAdmission', () => {
  test('refuses explicit rungs without the flag and preserves depth in the remedy', () => {
    const admission = decidePullRequestReleaseAdmission({
      decision: decided(plan('hosted-api', 'explicit'), plan('hub', 'explicit')),
      releaseRequired: false,
      target: '42',
      depth: 'staging',
    })
    expect(admission.kind).toBe('refuse')
    if (admission.kind === 'allow') return
    expect(admission.message).toContain('hosted-api, hub')
    expect(admission.message).toContain(
      `${PLATFORM_SLUG} pr merge 42 --release-required --depth staging`,
    )
  })

  test('allows explicit rungs with the flag', () => {
    expect(
      decidePullRequestReleaseAdmission({
        decision: decided(plan('hosted-api', 'explicit')),
        releaseRequired: true,
        target: '42',
      }),
    ).toEqual({ kind: 'allow' })
  })

  test('allows a change that requires no release rung', () => {
    expect(
      decidePullRequestReleaseAdmission({
        decision: decided(),
        releaseRequired: false,
        target: '42',
      }),
    ).toEqual({ kind: 'allow' })
  })

  test('allows a reach-only rung without the flag', () => {
    expect(
      decidePullRequestReleaseAdmission({
        decision: decided(plan('production', 'reach')),
        releaseRequired: false,
        target: '42',
      }),
    ).toEqual({ kind: 'allow' })
  })

  test('refuses an errored decision with its cause and the original merge command', () => {
    const admission = decidePullRequestReleaseAdmission({
      decision: { decided: false, required: [], rungs: [], error: 'closure build failed' },
      releaseRequired: true,
      target: 'DEV-2555',
      depth: 'staging',
    })
    expect(admission.kind).toBe('refuse')
    if (admission.kind === 'allow') return
    expect(admission.message).toContain('closure build failed')
    expect(admission.message).toContain(
      `cleared by: ${PLATFORM_SLUG} pr merge DEV-2555 --release-required --depth staging`,
    )
  })
})

describe('pullRequestReleaseNotice', () => {
  test('names explicitly required rungs and the release-required merge command', () => {
    expect(
      pullRequestReleaseNotice({
        decision: decided(plan('hosted-hub', 'explicit')),
        target: '2382',
      }),
    ).toBe(
      `release rung hosted-hub required by this pull request; merge with: ${PLATFORM_SLUG} pr merge 2382 --release-required`,
    )
  })

  test('names required rungs without a merge command when the pull request number is unknown', () => {
    expect(
      pullRequestReleaseNotice({
        decision: decided(plan('hosted-hub', 'explicit')),
        target: null,
      }),
    ).toBe('release rung hosted-hub required by this pull request')
  })

  test('reports an undecided requirement and says merge decides it again', () => {
    expect(
      pullRequestReleaseNotice({
        decision: { decided: false, required: [], rungs: [], error: 'closure unavailable' },
        target: 'DEV-2664',
      }),
    ).toBe(
      `release rung requirement could not be decided: closure unavailable; ${PLATFORM_SLUG} pr merge decides it again`,
    )
  })

  test('returns no notice when no rung is explicitly required', () => {
    expect(
      pullRequestReleaseNotice({
        decision: decided(plan('production', 'reach')),
        target: 'DEV-2664',
      }),
    ).toBeNull()
  })
})

describe('merge admission stays at least as strict as machine update', () => {
  const closure = new Map([
    ['hub/src/hosted.ts', new Set(['hub/src/hosted.ts', 'shared/call-budgets.ts'])],
  ])
  const cases: {
    name: string
    rung: RequiredReleaseRung
    changedPaths: string[]
    entryClosure: typeof closure
  }[] = [
    {
      name: 'requiredWhenChanged match',
      rung: {
        name: 'hosted-api',
        branch: 'main',
        deploy: 'deploy hosted-api',
        requiredWhenChanged: ['shared/record/**'],
      },
      changedPaths: ['shared/record/schema.ts'],
      entryClosure: new Map(),
    },
    {
      name: 'entry-closure-only match',
      rung: {
        name: 'hosted-hub',
        branch: 'main',
        deploy: 'deploy hosted-hub',
        requiredWhenChanged: ['hub/migrations/**'],
        entryPoints: ['hub/src/hosted.ts'],
      },
      changedPaths: ['shared/call-budgets.ts'],
      entryClosure: closure,
    },
    {
      name: 'non-trunk rung',
      rung: {
        name: 'production',
        branch: 'production',
        deploy: 'deploy production',
        requiredWhenChanged: ['packages/**'],
      },
      changedPaths: ['packages/app.ts'],
      entryClosure: new Map(),
    },
    {
      name: 'rung that cannot deploy from the release tree',
      rung: {
        name: 'manual',
        branch: 'main',
        requiredWhenChanged: ['manual/**'],
      },
      changedPaths: ['manual/runbook.ts'],
      entryClosure: new Map(),
    },
  ]

  test.each(cases)('$name', ({ rung, changedPaths, entryClosure }) => {
    const guarded = {
      path: '/fixture',
      name: 'fixture',
      settings: {
        trunk: 'main',
        worktree: { recipePath: `${PLATFORM_SLUG}.jsonc` },
        release: { rungs: [rung] },
      },
    } as Project
    let now = 0
    const dependencies: IncomingRequiredRungDependencies = {
      resolve: (ref) => (ref === 'HEAD' ? 'current' : 'incoming'),
      changedPaths: () => changedPaths,
      entryClosure: () => entryClosure,
      newestLive: () => null,
      contains: () => false,
      now: () => now++,
    }
    const machineRefusal = incomingRequiredRungGuard(guarded, 'main', dependencies).refusal
    const decision = requiredRungDecision(
      guarded,
      () => changedPaths,
      () => entryClosure,
    )
    const mergeAdmission = decidePullRequestReleaseAdmission({
      decision,
      releaseRequired: false,
      target: 'DEV-2664',
    })

    if (machineRefusal !== null) {
      expect(mergeAdmission.kind).toBe('refuse')
      expect(machineRefusal).toContain(rung.name)
      if (mergeAdmission.kind === 'refuse') expect(mergeAdmission.message).toContain(rung.name)
    }
  })
})

test('a project without explicit release requirements returns before changed-path git work', () => {
  const project = {
    path: '/fixture',
    settings: {
      trunk: 'main',
      release: { rungs: [{ name: 'production', branch: 'main' }] },
    },
  } as Project
  expect(
    pullRequestReleaseDecisionAtHead(project, '/path/that/does/not/exist', {
      headCommit: 'head',
      baseBranch: 'main',
    }),
  ).toEqual({ decided: true, required: [], rungs: [], error: null })
})

test('an explicitly required release rung refuses before the pull request is merged', async () => {
  registerProject([])
  recordPassingGate()
  let merged = false
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          releaseDecision: () => decided(plan('hosted-api', 'explicit')),
          merge: () => {
            merged = true
            return 'unexpected'
          },
        }),
      ),
  ).toThrow(`${PLATFORM_SLUG} pr merge 42 --release-required`)
  expect(merged).toBe(false)
})
