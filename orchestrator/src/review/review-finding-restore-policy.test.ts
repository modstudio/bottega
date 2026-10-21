import { expect, test } from 'bun:test'
import {
  decideFindingRestore,
  decideFindingRestores,
  type RestoreFindingFacts,
  type RestoreFindingPayload,
  reviewOrdinalKey,
} from './review-finding-restore-policy.ts'

const payload: RestoreFindingPayload = {
  recordId: 'finding-12',
  reviewRecordId: 'review-record',
  reviewLensRecordId: 'lens-record',
  ordinal: 3,
  severity: 'major',
  location: 'a.ts:4',
  evidence: 'evidence',
  proposedCorrection: 'correct it',
}

function facts(overrides: Partial<RestoreFindingFacts> = {}): RestoreFindingFacts {
  return {
    existingFindingIds: new Set(),
    findingIdByReviewOrdinal: new Map(),
    reviewIdByRecordId: new Map([['review-record', 'review-record']]),
    lensByRecordId: new Map([
      ['lens-record', { recordId: 'lens-record', reviewRecordId: 'review-record' }],
    ]),
    ...overrides,
  }
}

test('restores a missing finding through its record-linked parents', () => {
  expect(decideFindingRestore(payload, facts())).toEqual({
    action: 'insert',
    reviewRecordId: 'review-record',
    reviewLensRecordId: 'lens-record',
  })
})

test('classifies an identical repeated payload as a duplicate of the first winner', () => {
  expect(
    decideFindingRestores(
      [
        { outboxId: 1, payload },
        { outboxId: 2, payload: { ...payload } },
      ],
      facts(),
    ).map(({ action }) => action),
  ).toEqual(['insert', 'duplicate'])
})

test('refuses a repeated finding whose later payload conflicts with the first winner', () => {
  const decisions = decideFindingRestores(
    [
      { outboxId: 1, payload },
      { outboxId: 2, payload: { ...payload, evidence: 'different evidence' } },
    ],
    facts(),
  )
  expect(decisions.map(({ action }) => action)).toEqual(['insert', 'refuse'])
  expect(decisions[1]).toMatchObject({
    outboxId: 2,
    reason: 'finding finding-12 has conflicting outbox payloads',
  })
})

test('skips a finding whose original local id is already present', () => {
  expect(
    decideFindingRestore(payload, facts({ existingFindingIds: new Set([payload.recordId]) })),
  ).toEqual({ action: 'skip', reason: 'finding finding-12 is already present' })
})

test('refuses missing and inconsistent parents and occupied ordinals', () => {
  expect(decideFindingRestore(payload, facts({ reviewIdByRecordId: new Map() }))).toEqual({
    action: 'refuse',
    reason: 'finding finding-12 references missing review review-record',
  })
  expect(decideFindingRestore(payload, facts({ lensByRecordId: new Map() }))).toEqual({
    action: 'refuse',
    reason: 'finding finding-12 references missing review lens lens-record',
  })
  expect(
    decideFindingRestore(
      payload,
      facts({
        lensByRecordId: new Map([
          ['lens-record', { recordId: 'lens-record', reviewRecordId: 'other-review' }],
        ]),
      }),
    ),
  ).toMatchObject({ action: 'refuse' })
  expect(
    decideFindingRestore(
      payload,
      facts({
        findingIdByReviewOrdinal: new Map([[reviewOrdinalKey('review-record', 3), 'finding-99']]),
      }),
    ),
  ).toEqual({
    action: 'refuse',
    reason:
      'finding finding-12 cannot use review review-record ordinal 3; finding finding-99 already uses it',
  })
})
