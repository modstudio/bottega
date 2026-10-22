import { expect, test } from 'bun:test'
import {
  boardPushDecision,
  lateDeliveryDecision,
  reportReplySuccessorDecision,
} from './board-push-policy.ts'

const clock = Date.parse('2026-10-16T12:00:00.000Z')
const postedAt = '2026-10-16T11:00:00.000Z'

const decision = (input: Partial<Parameters<typeof boardPushDecision>[0]> = {}) =>
  boardPushDecision({
    acknowledgementRequired: true,
    postedAt,
    acknowledgementDeadline: '2026-10-16T13:00:00.000Z',
    expiresAt: '2026-10-17T12:00:00.000Z',
    purpose: 'request',
    readerBeganAt: '2026-10-16T10:00:00.000Z',
    clock,
    ...input,
  })

test('acknowledgement delivery ends at its deadline and belongs only to sessions already running', () => {
  expect(decision({ acknowledgementDeadline: '2026-10-16T11:59:59.999Z' })).toBe('withheld')
  expect(
    decision({
      acknowledgementDeadline: '2026-10-16T11:59:59.999Z',
      readerBeganAt: '2026-10-16T11:00:00.001Z',
    }),
  ).toBe('withheld')
  expect(decision()).toBe('acknowledgement')
  expect(decision({ readerBeganAt: null })).toBe('withheld')
  expect(decision({ readerBeganAt: 'unbounded' })).toBe('acknowledgement')
  expect(decision({ purpose: 'standing', readerBeganAt: '2026-10-16T11:00:00.001Z' })).toBe(
    'withheld',
  )
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'standing',
      readerBeganAt: '2026-10-16T11:00:00.001Z',
    }),
  ).toBe('ordinary')
})

test('an open unexpired request is delivered to a session that began before the post', () => {
  const rescued = {
    purpose: 'request' as const,
    inAudience: true,
    expired: false,
    hasReceipt: false,
    sessionBeganBeforePost: true,
  }
  expect(lateDeliveryDecision(rescued)).toBe('deliver')
  expect(lateDeliveryDecision({ ...rescued, purpose: 'standing' })).toBe('deliver')
  expect(lateDeliveryDecision({ ...rescued, hasReceipt: true })).toBe('skip')
  expect(lateDeliveryDecision({ ...rescued, expired: true })).toBe('skip')
  expect(lateDeliveryDecision({ ...rescued, inAudience: false })).toBe('skip')
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'request',
      readerBeganAt: '2026-10-16T10:00:00.000Z',
      inAudience: true,
      hasReceipt: false,
    }),
  ).toBe('ordinary')
})

test('a session that began after a post is not pushed an older request', () => {
  const later = '2026-10-16T11:00:00.001Z'
  expect(
    lateDeliveryDecision({
      purpose: 'request',
      inAudience: true,
      expired: false,
      hasReceipt: false,
      sessionBeganBeforePost: false,
    }),
  ).toBe('skip')
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'request',
      readerBeganAt: later,
    }),
  ).toBe('withheld')
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'information',
      readerBeganAt: later,
    }),
  ).toBe('withheld')
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'standing',
      readerBeganAt: later,
    }),
  ).toBe('ordinary')
  expect(decision({ readerBeganAt: later })).toBe('withheld')
})

test('a report reply reaches the first later architect session of the posting project', () => {
  const successor = {
    rootAuthorLive: false,
    readerIsArchitect: true,
    readerProject: 'starship',
    rootProject: 'starship',
    readerIsParticipant: false,
    successorAlreadyReceived: false,
  }
  expect(reportReplySuccessorDecision(successor)).toBe(true)
  expect(reportReplySuccessorDecision({ ...successor, rootAuthorLive: true })).toBe(false)
  expect(reportReplySuccessorDecision({ ...successor, readerIsParticipant: true })).toBe(false)
  expect(reportReplySuccessorDecision({ ...successor, successorAlreadyReceived: true })).toBe(false)
  expect(reportReplySuccessorDecision({ ...successor, readerProject: 'other' })).toBe(false)
  expect(reportReplySuccessorDecision({ ...successor, readerIsArchitect: false })).toBe(false)
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'information',
      readerBeganAt: '2026-10-16T11:00:00.001Z',
      reportReplySuccessor: true,
    }),
  ).toBe('ordinary')
})
