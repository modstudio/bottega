import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { utf8Bytes } from './outbox-read.ts'
import {
  RECORD_SYNC_MAX_PAYLOAD_BYTES,
  type RecordPayload,
} from './record-sync-contract.ts'
import { withholdReviewFunnelDecisionHistory } from './record-sync-review-funnel-decision.ts'

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('withholds review history arrays and merges their paths with existing withheld fields', () => {
  const branchReviews = [{ reviewRecordId: 'review-1' }]
  const rounds = [{ reviewRecordId: 'review-1', identity: 'correctness' }]
  const payload = {
    factsDigest: 'whole-facts-digest',
    facts: { branchReviews, rounds, files: ['kept'] },
    withheldFields: ['verdict.remedy'],
  }

  expect(withholdReviewFunnelDecisionHistory(payload)).toEqual({
    factsDigest: 'whole-facts-digest',
    facts: {
      branchReviews: { withheld: true, count: 1, digest: digest(branchReviews) },
      rounds: { withheld: true, count: 1, digest: digest(rounds) },
      files: ['kept'],
    },
    withheldFields: ['verdict.remedy', 'facts.branchReviews', 'facts.rounds'],
  })
  expect(payload.facts.branchReviews).toBe(branchReviews)
  expect(payload.facts.rounds).toBe(rounds)
})

test('leaves a payload without review history arrays unchanged', () => {
  const payload = { facts: { files: [] }, withheldFields: null }
  expect(withholdReviewFunnelDecisionHistory(payload)).toBe(payload)
})

test('bounds a decision payload with a large synthetic review history', () => {
  const branchReviews = Array.from({ length: 5_000 }, (_, index) => ({
    reviewRecordId: `review-${index}`,
    reviewNumber: index + 1,
    lenses: ['correctness', 'craft', 'tests'].map((lens) => ({
      recordId: `${lens}-${index}`,
      lens,
      graded: true,
      settled: true,
    })),
    findings: ['correctness', 'craft', 'tests'].map((lens, ordinal) => ({
      recordId: `finding-${index}-${ordinal}`,
      ordinal,
      disposition: 'fixed',
      lens,
    })),
  }))
  const rounds = Array.from({ length: 5_000 }, (_, index) => ({
    reviewRecordId: `review-${index}`,
    identity: `round-${index}`,
    provenance: { recorded: true, reviewedCommit: `commit-${index}` },
    landed: false,
  }))
  const payload: RecordPayload = {
    id: 'decision-record',
    factsDigest: 'whole-facts-digest',
    facts: { branchReviews, rounds, files: [{ path: 'kept.ts' }] },
    withheldFields: null,
  }
  const stored = JSON.stringify(payload)
  const preparedPayload = withholdReviewFunnelDecisionHistory(payload)
  const prepared = JSON.stringify(preparedPayload)

  expect(utf8Bytes(stored)).toBeGreaterThan(RECORD_SYNC_MAX_PAYLOAD_BYTES)
  expect(utf8Bytes(prepared)).toBeLessThan(RECORD_SYNC_MAX_PAYLOAD_BYTES)
  expect(preparedPayload.withheldFields).toEqual(['facts.branchReviews', 'facts.rounds'])
  expect(preparedPayload.facts).toMatchObject({
    branchReviews: { withheld: true, count: 5_000, digest: digest(branchReviews) },
    rounds: { withheld: true, count: 5_000, digest: digest(rounds) },
  })
})
