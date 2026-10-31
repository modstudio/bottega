import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  checkoutOutsideChangeRefusal,
  classifyCheckoutEvidence,
  classifyRecordedLandingEvidence,
  decideCheckoutAnswer,
} from './workflow-checkout-refusal.ts'

test('checkout evidence accepts a commit from the cursor branch', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: true,
      landingCommit: null,
      landingIsHeadOrAncestor: false,
    }),
  ).toBe('branch')
})

test('checkout evidence accepts a squash landing commit contained by the checkout head', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'squash-landing',
      landingIsHeadOrAncestor: true,
    }),
  ).toBe('post-landing')
})

test('checkout evidence accepts a checkout off trunk when it contains the landing commit', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'landing',
      landingIsHeadOrAncestor: true,
    }),
  ).toBe('post-landing')
})

test('checkout evidence refuses a trunk commit before the recorded landing', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'later-landing',
      landingIsHeadOrAncestor: false,
    }),
  ).toBe('outside-change')
})

test('checkout evidence refuses an unrelated head with no landing commit', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: null,
      landingIsHeadOrAncestor: false,
    }),
  ).toBe('outside-change')
})

test('an unavailable landing commit names the condition and pull remedy', () => {
  const refusal = checkoutOutsideChangeRefusal('--gate 3042', 'DEV-1535-work', '/fixture/main', {
    project: 'fixture',
    branch: 'main',
    checkoutPath: '/fixture/main',
    headIsTipOrAncestor: false,
    landingCommit: 'dd3e2d8050120bf3d676f86257d0c92c0c5bff41',
    landingIsHeadOrAncestor: undefined,
    landingBranch: 'main',
  })
  expect(refusal).toContain(
    'landing commit dd3e2d8050120bf3d676f86257d0c92c0c5bff41 is not available in /fixture/main',
  )
  expect(refusal).toContain('git pull --ff-only origin main')
})

test('every outside-change refusal path names a runnable remedy command', () => {
  const base = {
    project: 'fixture',
    branch: 'main',
    checkoutPath: '/fixture/main',
    headIsTipOrAncestor: false,
    landingBranch: 'main',
  }
  const landingCommit = 'dd3e2d8050120bf3d676f86257d0c92c0c5bff41'
  const refusals = [
    checkoutOutsideChangeRefusal('--gate 3042', 'DEV-1535-work', '/fixture/main', {
      ...base,
      landingCommit,
      landingIsHeadOrAncestor: undefined,
    }),
    checkoutOutsideChangeRefusal('--gate 3042', 'DEV-1535-work', '/fixture/main', {
      ...base,
      landingCommit,
      landingIsHeadOrAncestor: false,
    }),
    checkoutOutsideChangeRefusal('--gate 3042', 'DEV-1535-work', '/fixture/main', {
      ...base,
      landingCommit: null,
      landingIsHeadOrAncestor: false,
    }),
  ]

  for (const refusal of refusals) {
    const command = refusal.match(/`([^`]+)`/)?.[1]
    expect(command?.startsWith(`${PLATFORM_SLUG} `) || command?.startsWith('git ')).toBe(true)
  }
  expect(refusals[1]).toContain(`${PLATFORM_SLUG} tree refresh ${base.checkoutPath}`)
  expect(refusals[1]).toContain(landingCommit)
})

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
