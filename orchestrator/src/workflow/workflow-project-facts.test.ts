import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { WorkflowAutonomyResolution } from './autonomy.ts'
import { type MergedChangeSources, resolveWorkflowProjectFacts } from './workflow-project-facts.ts'
import { parseWorkflowTree } from './workflow-tree.ts'

const autonomy: WorkflowAutonomyResolution = {
  steps: {},
  rulings: { value: 'user', scope: 'test' },
  shipTo: { value: 'trunk', scope: 'test' },
}
const unusedMergedChangeSources: MergedChangeSources = {
  landing: () => null,
  changedPaths: () => [],
}

describe('workflow project facts', () => {
  test('exposes a declared generated reference', () => {
    const reference = {
      directory: 'docs/reference',
      publish: `${PLATFORM_SLUG} doc reference publish`,
    }
    const { facts } = resolveWorkflowProjectFacts(
      { name: 'fixture', stack: 'bun', settings: { reference } },
      ['reference'],
      false,
      {},
      autonomy,
      [],
      unusedMergedChangeSources,
    )

    expect(facts).toEqual({ reference })
  })

  test('open-pr composition carries declared before-pull-request entries', () => {
    const beforePullRequest = [
      {
        whenChanged: ['shared/record/migrations/**'],
        run: 'bun scripts/rehearse.ts',
        secrets: ['REHEARSAL_TOKEN'],
      },
    ]
    const path = resolve(import.meta.dir, '../../../.agents/workflow-steps/open-pr.md')
    const openPullRequest = parseWorkflowTree([
      { path: '.agents/workflow-steps/open-pr.md', body: readFileSync(path, 'utf8') },
    ]).steps[0]!
    const { facts } = resolveWorkflowProjectFacts(
      {
        name: 'fixture',
        stack: 'bun',
        settings: {
          trunk: 'main',
          release: { rungs: [], mergeMethod: 'squash', requiredChecks: [], beforePullRequest },
        },
      },
      openPullRequest.needs,
      false,
      {},
      autonomy,
      [],
      unusedMergedChangeSources,
    )

    expect(facts).toEqual({ trunk: 'main', beforePullRequest })
  })

  test('a step needing before-pull-request receives the declared entries', () => {
    const beforePullRequest = [
      {
        whenChanged: ['shared/record/migrations/**'],
        run: 'bun scripts/rehearse.ts',
        secrets: ['REHEARSAL_TOKEN'],
      },
    ]
    const step = parseWorkflowTree([
      {
        path: '.agents/workflow-steps/synthetic.md',
        body: `---
title: Synthetic
floor: []
job: null
autonomy: ask
needs:
  - before-pull-request
---
Synthetic body.
`,
      },
    ]).steps[0]!
    const declared = resolveWorkflowProjectFacts(
      {
        name: 'fixture',
        stack: 'bun',
        settings: {
          trunk: 'main',
          release: { rungs: [], mergeMethod: 'squash', requiredChecks: [], beforePullRequest },
        },
      },
      step.needs,
      false,
      {},
      autonomy,
      [],
      unusedMergedChangeSources,
    ).facts
    const absent = resolveWorkflowProjectFacts(
      { name: 'fixture', stack: 'bun', settings: {} },
      step.needs,
      false,
      {},
      autonomy,
      [],
      unusedMergedChangeSources,
    ).facts

    expect(declared).toEqual({ beforePullRequest })
    expect(absent).toEqual({ beforePullRequest: [] })
  })

  test.each([
    ['with a review state', [{ name: 'production', branch: 'production' }]],
    ['with no remaining rungs', []],
  ] as const)('ship-to branch asks the operator %s', (_case, rungs) => {
    const { facts } = resolveWorkflowProjectFacts(
      {
        name: 'fixture',
        stack: 'bun',
        settings: {
          tracker: { protocol: 'hub' },
          release: { rungs: [...rungs], mergeMethod: 'squash', requiredChecks: [] },
        },
      },
      ['tracker', 'release', 'ship-to'],
      true,
      {},
      { ...autonomy, shipTo: { value: 'branch', scope: 'test' } },
      [],
      unusedMergedChangeSources,
    )

    expect(facts.shipTo).toMatchObject({
      closeAction: 'ask',
      closeFloor: 'ruling',
      closeState: 'none',
    })
  })

  test('ship-to trunk with no remaining rungs closes as done', () => {
    const { facts } = resolveWorkflowProjectFacts(
      {
        name: 'fixture',
        stack: 'bun',
        settings: {
          tracker: { protocol: 'hub' },
          release: { rungs: [], mergeMethod: 'squash', requiredChecks: [] },
        },
      },
      ['tracker', 'release', 'ship-to'],
      true,
      {},
      autonomy,
      [],
      unusedMergedChangeSources,
    )

    expect(facts.shipTo).toMatchObject({
      closeAction: 'done',
      closeFloor: 'tracker-transition',
      closeState: 'done',
    })
  })

  test('a tracker that completes on merge closes as done while rungs remain', () => {
    const { facts } = resolveWorkflowProjectFacts(
      {
        name: 'fixture',
        stack: 'bun',
        settings: {
          tracker: { protocol: 'hub', completesOnMerge: true },
          release: {
            rungs: [{ name: 'production', branch: 'production' }],
            mergeMethod: 'squash',
            requiredChecks: [],
          },
        },
      },
      ['tracker', 'release', 'ship-to'],
      true,
      {},
      autonomy,
      [],
      unusedMergedChangeSources,
    )

    expect(facts.shipTo).toMatchObject({
      closeAction: 'done',
      closeFloor: 'tracker-transition',
      closeState: 'done',
    })
  })

  test.each([
    {
      case: 'skips an unmatched release rung',
      landing: 'merge-1',
      changedPaths: ['scripts/verify.ts'],
      expected: {
        reach: [],
        skipped: [
          {
            name: 'production',
            reason:
              'no release artifact in this change: no changed path matches package.json, src/**',
          },
        ],
        skippedText:
          'production (no release artifact in this change: no changed path matches package.json, src/**)',
      },
    },
    {
      case: 'keeps a matched release rung',
      landing: 'merge-1',
      changedPaths: ['src/index.ts'],
      expected: { reach: ['production'], skipped: [], skippedText: 'none' },
    },
    {
      case: 'refuses when the merged commit cannot be established',
      landing: null,
      changedPaths: [],
      refusal: `cannot establish the merged commit of DEV-1917-change: no landing is recorded and no merged pull request is known for it; cleared by: ${PLATFORM_SLUG} tree branch landed DEV-1917-change --pr <number> for a run branch, or merging its pull request through ${PLATFORM_SLUG} pr merge`,
    },
  ])('$case', ({ landing, changedPaths, expected, refusal }) => {
    const resolve = () =>
      resolveWorkflowProjectFacts(
        {
          name: 'fixture',
          stack: 'bun',
          settings: {
            release: {
              rungs: [
                {
                  name: 'production',
                  branch: 'production',
                  releasesWhenChanged: ['package.json', 'src/**'],
                },
              ],
              mergeMethod: 'squash',
              requiredChecks: [],
            },
          },
        },
        ['release', 'ship-to', 'merged-change'],
        false,
        { branch: 'DEV-1917-change' },
        { ...autonomy, shipTo: { value: 'production', scope: 'test' } },
        [],
        {
          landing: () => landing,
          changedPaths: (_project, mergeCommit) => {
            expect(mergeCommit).toBe('merge-1')
            return changedPaths
          },
        },
      )

    if (refusal) expect(resolve).toThrow(refusal)
    else expect(resolve().facts.shipTo).toMatchObject(expected!)
  })
})
