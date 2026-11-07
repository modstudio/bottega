import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  encodePullRequestPostLandingPayload,
  type PullRequestPostLandingPayload,
  parsePullRequestPostLandingPayload,
} from './pr-post-landing-payload.ts'

const payload: PullRequestPostLandingPayload = {
  project: PLATFORM_SLUG,
  target: '42',
  prNumber: 42,
  headBranch: 'DEV-2004-post-landing',
  headCommit: 'head',
  mergeCommit: 'merge',
  requiredRungs: ['hosted-api'],
  rungDecisionError: null,
  releaseRequired: true,
  depth: null,
  promoteWorkflowDrafts: true,
  recordingError: null,
  requeueOutput: null,
}

// This fixture is the shape a previous binary writes, so it changes only deliberately. A new
// field must decode from it unchanged.
const previousBinaryPayload = readFileSync(
  fileURLToPath(new URL('./pr-post-landing-payload.fixture.json', import.meta.url)),
  'utf8',
)
const expectedPreviousBinaryPayload: PullRequestPostLandingPayload = {
  project: 'fixture-project',
  target: '42',
  prNumber: 42,
  headBranch: 'DEV-2032-post-landing',
  headCommit: 'head',
  mergeCommit: 'merge',
  requiredRungs: ['hosted-api'],
  rungPlans: [
    {
      rung: 'hosted-api',
      branch: 'main',
      required: true,
      requiredBy: 'reach',
      reason: null,
      declaresLive: false,
      declaresDeploy: true,
    },
  ],
  rungDecisionError: null,
  releaseRequired: true,
  depth: 'hosted-api',
  promoteWorkflowDrafts: true,
  recordingError: null,
  requeueOutput: null,
}

test('post-landing payload decodes the previous binary fixture', () => {
  expect(parsePullRequestPostLandingPayload(previousBinaryPayload)).toEqual(
    expectedPreviousBinaryPayload,
  )
})

test('post-landing payload reads an absent fixture depth as null', () => {
  const withoutDepth = JSON.parse(previousBinaryPayload) as Record<string, unknown>
  delete withoutDepth.depth

  expect(parsePullRequestPostLandingPayload(JSON.stringify(withoutDepth)).depth).toBeNull()
})

test('post-landing payload round trips every fixed identity field', () => {
  expect(parsePullRequestPostLandingPayload(encodePullRequestPostLandingPayload(payload))).toEqual(
    payload,
  )
})

test('post-landing payload carries the release plan requirement source', () => {
  const withPlan: PullRequestPostLandingPayload = {
    ...payload,
    rungPlans: [
      {
        rung: 'hosted-api',
        branch: 'main',
        required: true,
        requiredBy: 'reach',
        reason: null,
        declaresLive: false,
        declaresDeploy: true,
      },
    ],
  }

  expect(parsePullRequestPostLandingPayload(encodePullRequestPostLandingPayload(withPlan))).toEqual(
    withPlan,
  )
})

test.each(Object.keys(payload).filter((field) => field !== 'depth'))(
  'post-landing payload refuses missing %s',
  (field) => {
    const incomplete = { ...payload } as Record<string, unknown>
    delete incomplete[field]
    expect(() => parsePullRequestPostLandingPayload(JSON.stringify(incomplete))).toThrow(field)
  },
)

test.each(['', 5, false])('post-landing payload refuses invalid depth %p', (depth) => {
  expect(() => parsePullRequestPostLandingPayload(JSON.stringify({ ...payload, depth }))).toThrow(
    'depth',
  )
})

test.each(['branch', 'declaresDeploy'] as const)(
  'post-landing payload refuses a rung plan missing %s',
  (field) => {
    const plan = {
      rung: 'hosted-api',
      branch: 'main',
      required: true,
      requiredBy: 'reach',
      reason: null,
      declaresLive: false,
      declaresDeploy: true,
    }
    delete (plan as Partial<typeof plan>)[field]

    expect(() =>
      parsePullRequestPostLandingPayload(JSON.stringify({ ...payload, rungPlans: [plan] })),
    ).toThrow('rungPlans')
  },
)
