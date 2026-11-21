import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import type { ReleaseRungPlan, RequiredRungDecision } from '../release/release-required.ts'
import { adapter, cwd, recordPassingGate, registerProject } from './pr-merge.fixture.ts'
import { mergePullRequest } from './pr-merge.ts'
import {
  decidePullRequestReleaseAdmission,
  pullRequestReleaseDecisionAtHead,
} from './pr-release-admission.ts'

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
