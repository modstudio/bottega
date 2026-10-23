import { expect, test } from 'bun:test'
import {
  classifyCheckoutEvidence,
  classifyRecordedLandingEvidence,
  decideCheckoutAnswer,
} from './workflow-checkout-refusal.ts'

test('an existing recorded cwd answers checkout questions', () => {
  expect(
    decideCheckoutAnswer({
      recordedCwd: '/fixture/work',
      recordedCwdIsDirectory: true,
      mainCheckoutPath: '/fixture/main',
    }),
  ).toEqual({ checkoutPath: '/fixture/work' })
})

test('the registered main checkout answers after the recorded cwd is removed', () => {
  expect(
    decideCheckoutAnswer({
      recordedCwd: '/fixture/removed-work',
      recordedCwdIsDirectory: false,
      mainCheckoutPath: '/fixture/main',
    }),
  ).toEqual({ checkoutPath: '/fixture/main' })
})

test('a removed cwd without a registered main checkout names both missing facts', () => {
  const answer = decideCheckoutAnswer({
    recordedCwd: '/fixture/removed-work',
    recordedCwdIsDirectory: false,
    mainCheckoutPath: null,
  })
  expect(answer).toHaveProperty('refusal')
  expect(answer).not.toHaveProperty('checkoutPath')
})

test('recorded landing accepts its exact tip after the branch ref is gone', () => {
  expect(
    classifyRecordedLandingEvidence({
      recordedTip: 'branch-tip',
      headIsRecordedTipOrAncestor: true,
      landingCommit: 'squash-landing',
      landingIsOnTrunk: true,
    }),
  ).toBe('post-landing')
})

test('a head unrelated to the recorded tip or the landing is outside the change', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'squash-landing',
      landingIsHeadOrAncestor: false,
      recordedLandingTip: 'branch-tip',
      headIsRecordedTipOrAncestor: false,
      landingIsOnTrunk: true,
    }),
  ).toBe('outside-change')
})

test('evidence recorded after the landing stays post-landing once the branch ref is gone', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'squash-landing',
      landingIsHeadOrAncestor: true,
      recordedLandingTip: 'branch-tip',
      headIsRecordedTipOrAncestor: false,
      landingIsOnTrunk: true,
    }),
  ).toBe('post-landing')
})

test('no recorded landing leaves checkout classification unchanged', () => {
  expect(
    classifyRecordedLandingEvidence({
      recordedTip: null,
      headIsRecordedTipOrAncestor: false,
      landingCommit: 'squash-landing',
      landingIsOnTrunk: true,
    }),
  ).toBeNull()
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'squash-landing',
      landingIsHeadOrAncestor: true,
      recordedLandingTip: null,
    }),
  ).toBe('post-landing')
})
