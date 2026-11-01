import { expect, test } from 'bun:test'
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
  releaseRequired: true,
  promoteWorkflowDrafts: true,
  recordingError: null,
  requeueOutput: null,
}

test('post-landing payload round trips every fixed identity field', () => {
  expect(parsePullRequestPostLandingPayload(encodePullRequestPostLandingPayload(payload))).toEqual(
    payload,
  )
})

test.each(Object.keys(payload))('post-landing payload refuses missing %s', (field) => {
  const incomplete = { ...payload } as Record<string, unknown>
  delete incomplete[field]
  expect(() => parsePullRequestPostLandingPayload(JSON.stringify(incomplete))).toThrow(field)
})
