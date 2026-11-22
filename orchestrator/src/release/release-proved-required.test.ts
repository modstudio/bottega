import { describe, expect, test } from 'bun:test'
import { releaseAfterProvedRequiredRelease } from './release-required.ts'

const releasePlan = (rung: string, canDeployFromTree: boolean) => ({
  rung,
  branch: 'main',
  required: true,
  requiredBy: 'explicit' as const,
  reason: null,
  declaresLive: true,
  declaresDeploy: canDeployFromTree,
  canDeployFromTree,
})

const outcome = (rung: string, outputTail: string) => ({
  rung,
  required: true,
  deployExit: 0,
  outputTail,
  satisfied: true,
  deployed: true,
})

describe('releaseAfterProvedRequiredRelease', () => {
  test('merges pre-move proofs and after-move releases by rung in plan order', () => {
    const plans = [releasePlan('tree-rung', true), releasePlan('ci-rung', false)]
    const report = releaseAfterProvedRequiredRelease({
      plans,
      proved: {
        required: ['tree-rung'],
        releases: [outcome('tree-rung', 'proved before move')],
        satisfied: true,
      },
      releaseAfter: (remaining) => {
        expect(remaining.map(({ rung, required }) => [rung, required])).toEqual([
          ['tree-rung', false],
          ['ci-rung', true],
        ])
        return {
          required: ['ci-rung'],
          releases: [
            { ...outcome('ci-rung', 'proved after move'), deployed: true },
            {
              ...outcome('tree-rung', 'not redeployed'),
              required: false,
              deployed: false,
            },
          ],
          satisfied: true,
        }
      },
    })

    expect(report.releases.map(({ rung, outputTail }) => [rung, outputTail])).toEqual([
      ['tree-rung', 'proved before move'],
      ['ci-rung', 'proved after move'],
    ])
    expect(report.satisfied).toBe(true)
  })

  test('fails when a required tree-deployable rung is missing its pre-move proof', () => {
    const plans = [releasePlan('tree-rung', true), releasePlan('ci-rung', false)]
    const report = releaseAfterProvedRequiredRelease({
      plans,
      proved: { required: ['tree-rung'], releases: [], satisfied: false },
      releaseAfter: () => ({
        required: ['ci-rung'],
        releases: [
          { ...outcome('tree-rung', 'rewritten plan was treated as satisfied'), required: false },
          outcome('ci-rung', 'proved after move'),
        ],
        satisfied: true,
      }),
    })

    expect(report.releases[0]).toMatchObject({
      rung: 'tree-rung',
      required: true,
      satisfied: false,
      outputTail: 'required rung tree-rung is missing its pre-move release proof',
    })
    expect(report.satisfied).toBe(false)
  })
})
