import { expect, test } from 'bun:test'
import { decidePrePush } from './pre-push-decision.ts'

const known = ['DEV-977-run', 'DEV-977-minted']

test('pre-push ignores tags, non-head destinations, and unknown branches', () => {
  expect(
    decidePrePush({ remoteRef: 'refs/tags/v1', recordedBranches: known, triageComplete: false }),
  ).toEqual({ admit: true, check: false, reason: 'non-branch' })
  expect(
    decidePrePush({ remoteRef: 'refs/notes/x', recordedBranches: known, triageComplete: false }),
  ).toEqual({ admit: true, check: false, reason: 'non-branch' })
  expect(
    decidePrePush({ remoteRef: 'refs/heads/main', recordedBranches: known, triageComplete: false }),
  ).toEqual({ admit: true, check: false, reason: 'unknown-branch' })
})

test('pre-push classifies the destination branch independently of local source', () => {
  expect(
    decidePrePush({
      remoteRef: 'refs/heads/DEV-977-run',
      recordedBranches: known,
      triageComplete: false,
    }),
  ).toEqual({ admit: false, check: true, reason: 'incomplete' })
  expect(
    decidePrePush({
      remoteRef: 'refs/heads/DEV-977-minted',
      recordedBranches: known,
      triageComplete: true,
    }),
  ).toEqual({ admit: true, check: true, reason: 'complete' })
})

test('pre-push fails open when triage infrastructure is unavailable', () => {
  expect(
    decidePrePush({
      remoteRef: 'refs/heads/DEV-977-run',
      recordedBranches: known,
      triageComplete: null,
    }),
  ).toEqual({ admit: true, check: true, reason: 'infrastructure-unavailable' })
})
