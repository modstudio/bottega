import { expect, test } from 'bun:test'
import type { ReleaseResult } from '../release/release-service.ts'
import { releaseAtCommitProof } from './release.ts'

test('release at a commit exits nonzero when deploy succeeds without a matching live proof', () => {
  const proof = releaseAtCommitProof({
    id: 1,
    project: 'fixture',
    rung: 'hosted-api',
    branch: 'main',
    deployed: 'candidate-commit',
    trunk: 'main',
    commitsBehindTrunk: 0,
    behindTrunkReason: null,
    liveBefore: 'old-live',
    baseline: false,
    rollback: false,
    rollbackReason: null,
    exitCode: 0,
    outputTail: 'deploy succeeded',
    liveAfter: 'different-live-commit',
    liveMatchesCandidate: false,
    warning: null,
    alreadyLive: false,
    landingAhead: false,
  } satisfies ReleaseResult)

  expect(proof).toMatchObject({
    satisfied: false,
    candidate: 'candidate-commit',
    live: 'different-live-commit',
    liveMatchesCandidate: false,
  })
  expect(proof.exitCode).not.toBe(0)
  expect(proof.failure).toContain(
    'live commit different-live-commit does not contain candidate candidate-commit',
  )
})
