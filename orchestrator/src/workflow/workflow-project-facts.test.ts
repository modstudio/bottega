import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { WorkflowAutonomyResolution } from './autonomy.ts'
import { resolveWorkflowProjectFacts } from './workflow-project-facts.ts'
import { parseWorkflowTree } from './workflow-tree.ts'

const autonomy: WorkflowAutonomyResolution = {
  steps: {},
  rulings: { value: 'user', scope: 'test' },
  shipTo: { value: 'trunk', scope: 'test' },
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
    )

    expect(facts).toEqual({ trunk: 'main', beforePullRequest })
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
    )

    expect(facts.shipTo).toMatchObject({
      closeAction: 'done',
      closeFloor: 'tracker-transition',
      closeState: 'done',
    })
  })
})
