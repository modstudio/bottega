import { expect, test } from 'bun:test'
import {
  BOARD_CLAIM_DEFAULT_MS,
  claimCloseReason,
  claimDurationRefusal,
  claimIsLive,
  claimNote,
  claimSubjectsConflict,
  claimTakeDecision,
  mayForceClaim,
  mayReleaseClaim,
  mayRenewClaim,
  parseClaimSubject,
} from './board-claim-policy.ts'

const architect = { kind: 'architect' as const, session: 'holder' }
const other = { kind: 'architect' as const, session: 'other' }
const operator = { kind: 'operator' as const, session: null }

test('claim liveness derives closure, lapse, and the latest tied run state', () => {
  expect(claimIsLive({ closed: false, lapsesAt: 101, runStatus: null, now: 100 })).toBeTrue()
  expect(claimIsLive({ closed: true, lapsesAt: 101, runStatus: null, now: 100 })).toBeFalse()
  expect(claimCloseReason({ closed: true, lapsesAt: 101, runStatus: null, now: 100 })).toBeNull()
  expect(claimCloseReason({ closed: false, lapsesAt: 100, runStatus: null, now: 100 })).toBe(
    'lapsed',
  )
  expect(claimIsLive({ closed: false, lapsesAt: 101, runStatus: 'running', now: 100 })).toBeTrue()
  expect(claimIsLive({ closed: false, lapsesAt: 101, runStatus: 'asking', now: 100 })).toBeTrue()
  expect(claimCloseReason({ closed: false, lapsesAt: 101, runStatus: 'ok', now: 100 })).toBe(
    'run-ended',
  )
})

test('claims conflict only within a kind, with symmetric path glob matching', () => {
  expect(
    claimSubjectsConflict({ kind: 'task', value: 'DEV-1' }, { kind: 'task', value: 'DEV-1' }),
  ).toBeTrue()
  expect(
    claimSubjectsConflict({ kind: 'resource', value: 'gpu' }, { kind: 'resource', value: 'gpu' }),
  ).toBeTrue()
  expect(
    claimSubjectsConflict({ kind: 'path', value: 'src/**' }, { kind: 'path', value: 'src/a.ts' }),
  ).toBeTrue()
  expect(
    claimSubjectsConflict({ kind: 'path', value: 'src/a.ts' }, { kind: 'path', value: 'src/**' }),
  ).toBeTrue()
  expect(
    claimSubjectsConflict({ kind: 'path', value: 'src/**' }, { kind: 'path', value: 'test/a.ts' }),
  ).toBeFalse()
  expect(
    claimSubjectsConflict({ kind: 'task', value: 'same' }, { kind: 'resource', value: 'same' }),
  ).toBeFalse()
})

test('claim subject, note, and duration refusals match the local adapter rules', () => {
  expect(parseClaimSubject('path:src/**')).toEqual({ kind: 'path', value: 'src/**' })
  expect(() => parseClaimSubject('other:x')).toThrow(/task:<KEY>/)
  expect(claimNote(undefined)).toBeUndefined()
  expect(claimNote('  ')).toBeNull()
  expect(claimNote(' held ')).toBe('held')
  expect(() => parseClaimSubject('task:DEV-1\nforged')).toThrow(
    /claim subject contains a line break/,
  )
  expect(() => claimNote('held\u2028forged')).toThrow(/claim note contains a line break/)
  expect(claimDurationRefusal(0)).toContain('positive')
  expect(claimDurationRefusal(BOARD_CLAIM_DEFAULT_MS)).toBeNull()
})

test('take decision covers take, renewal, refusal, stale takeover, and operator force', () => {
  expect(
    claimTakeDecision({
      sameHolderSameSubject: false,
      conflictingClaim: false,
      foreignLiveConflict: false,
      force: false,
      actorKind: 'architect',
    }),
  ).toBe('take')
  expect(
    claimTakeDecision({
      sameHolderSameSubject: true,
      conflictingClaim: true,
      foreignLiveConflict: false,
      force: false,
      actorKind: 'architect',
    }),
  ).toBe('renew')
  expect(
    claimTakeDecision({
      sameHolderSameSubject: false,
      conflictingClaim: true,
      foreignLiveConflict: true,
      force: false,
      actorKind: 'architect',
    }),
  ).toBe('refuse')
  expect(
    claimTakeDecision({
      sameHolderSameSubject: false,
      conflictingClaim: true,
      foreignLiveConflict: false,
      force: false,
      actorKind: 'architect',
    }),
  ).toBe('take-over')
  expect(
    claimTakeDecision({
      sameHolderSameSubject: false,
      conflictingClaim: true,
      foreignLiveConflict: true,
      force: true,
      actorKind: 'operator',
    }),
  ).toBe('take-over')
  expect(
    claimTakeDecision({
      sameHolderSameSubject: false,
      conflictingClaim: true,
      foreignLiveConflict: true,
      force: true,
      actorKind: 'architect',
    }),
  ).toBe('refuse')
})

test('renew, release, and force authorities are explicit', () => {
  expect(mayRenewClaim(architect, architect)).toBeTrue()
  expect(mayRenewClaim(other, architect)).toBeFalse()
  expect(mayReleaseClaim(architect, architect)).toBeTrue()
  expect(mayReleaseClaim(other, architect)).toBeFalse()
  expect(mayReleaseClaim(operator, architect)).toBeTrue()
  expect(mayForceClaim(operator)).toBeTrue()
  expect(mayForceClaim(architect)).toBeFalse()
})
