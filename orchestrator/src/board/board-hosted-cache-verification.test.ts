import { expect, test } from 'bun:test'
import {
  BOARD_UNVERIFIED_NOTICE_AFTER_MS,
  hostedBoardVerificationNoticeDecision,
} from './board-hosted-cache.ts'

const verifiedAt = '2026-10-05T12:00:00.000Z'
const verifiedAtMs = Date.parse(verifiedAt)

test('a short verification failure and its recovery stay silent', () => {
  expect(
    hostedBoardVerificationNoticeDecision({
      currentlyUnverified: true,
      lastVerifiedAt: verifiedAt,
      now: verifiedAtMs + BOARD_UNVERIFIED_NOTICE_AFTER_MS - 1,
      unverifiedNoticeAnnounced: false,
    }),
  ).toBeNull()
  expect(
    hostedBoardVerificationNoticeDecision({
      currentlyUnverified: false,
      lastVerifiedAt: verifiedAt,
      now: verifiedAtMs + BOARD_UNVERIFIED_NOTICE_AFTER_MS - 1,
      unverifiedNoticeAnnounced: false,
    }),
  ).toBeNull()
})

test('a persistent verification failure announces once and announces its recovery once', () => {
  expect(
    hostedBoardVerificationNoticeDecision({
      currentlyUnverified: true,
      lastVerifiedAt: verifiedAt,
      now: verifiedAtMs + BOARD_UNVERIFIED_NOTICE_AFTER_MS,
      unverifiedNoticeAnnounced: false,
    }),
  ).toBe('announce-unverified')
  expect(
    hostedBoardVerificationNoticeDecision({
      currentlyUnverified: true,
      lastVerifiedAt: verifiedAt,
      now: verifiedAtMs + BOARD_UNVERIFIED_NOTICE_AFTER_MS + 1,
      unverifiedNoticeAnnounced: true,
    }),
  ).toBeNull()
  expect(
    hostedBoardVerificationNoticeDecision({
      currentlyUnverified: false,
      lastVerifiedAt: verifiedAt,
      now: verifiedAtMs + BOARD_UNVERIFIED_NOTICE_AFTER_MS + 1,
      unverifiedNoticeAnnounced: true,
    }),
  ).toBe('announce-recovered')
  expect(
    hostedBoardVerificationNoticeDecision({
      currentlyUnverified: false,
      lastVerifiedAt: verifiedAt,
      now: verifiedAtMs + BOARD_UNVERIFIED_NOTICE_AFTER_MS + 2,
      unverifiedNoticeAnnounced: false,
    }),
  ).toBeNull()
})

test('a cache that never verified announces at the first check', () => {
  expect(
    hostedBoardVerificationNoticeDecision({
      currentlyUnverified: true,
      lastVerifiedAt: null,
      now: verifiedAtMs,
      unverifiedNoticeAnnounced: false,
    }),
  ).toBe('announce-unverified')
})
