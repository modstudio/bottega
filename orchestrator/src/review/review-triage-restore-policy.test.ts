import { expect, test } from 'bun:test'
import {
  decideTriageRestore,
  TRIAGE_RESTORE_SKIP_REASONS,
  type TriageRestoreFacts,
  type TriageRestoreSource,
} from './review-triage-restore-policy.ts'

const source: TriageRestoreSource = {
  outboxId: 10,
  recordId: 'original-finding',
  reviewRecordId: 'review-record',
  localId: 4,
  ordinal: 2,
  severity: 'high',
  location: 'file.ts:2',
  evidence: 'evidence',
  disposition: 'accepted',
  rejectionCategory: null,
  triagedSeverity: 'high',
  triagedAt: '2026-09-20T12:00:00.000Z',
  withheldFields: [],
}

function facts(overrides: Partial<TriageRestoreFacts> = {}): TriageRestoreFacts {
  return {
    finding: {
      id: 4,
      reviewRecordId: 'review-record',
      ordinal: 2,
      severity: 'high',
      location: 'file.ts:2',
      evidence: 'evidence',
      recordId: 'reminted-finding',
      completedAt: '2026-09-21T12:00:00.000Z',
    },
    source,
    sourceStatus: 'valid',
    liveRecordIdReferenced: false,
    ...overrides,
  }
}

test('restores matching completed triage and its original record identity', () => {
  expect(decideTriageRestore(facts())).toEqual({
    action: 'apply',
    restoreRecordId: true,
    source,
  })
})

test('ignores withheld identity fields but still requires structural identity', () => {
  const withheldSource = {
    ...source,
    severity: '[withheld]',
    location: '[withheld]',
    evidence: '[withheld]',
    withheldFields: ['severity', 'location', 'evidence'],
  }
  expect(decideTriageRestore(facts({ source: withheldSource }))).toEqual({
    action: 'apply',
    restoreRecordId: true,
    source: withheldSource,
  })
  expect(
    decideTriageRestore(facts({ source: { ...withheldSource, localId: source.localId + 1 } })),
  ).toEqual({ action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.identityMismatch })
})

test('skips each unsafe source class with its stable reason', () => {
  expect(decideTriageRestore(facts({ source: null, sourceStatus: 'missing' }))).toEqual({
    action: 'skip',
    reason: TRIAGE_RESTORE_SKIP_REASONS.noSource,
  })
  expect(decideTriageRestore(facts({ source: { ...source, disposition: null } }))).toEqual({
    action: 'skip',
    reason: TRIAGE_RESTORE_SKIP_REASONS.nullDisposition,
  })
  expect(
    decideTriageRestore(facts({ source: { ...source, evidence: 'different evidence' } })),
  ).toEqual({ action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.identityMismatch })
  expect(
    decideTriageRestore(facts({ finding: { ...facts().finding, completedAt: null } })),
  ).toEqual({ action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.openReview })
  expect(decideTriageRestore(facts({ liveRecordIdReferenced: true }))).toEqual({
    action: 'skip',
    reason: TRIAGE_RESTORE_SKIP_REASONS.hostedDivergence,
  })
})
