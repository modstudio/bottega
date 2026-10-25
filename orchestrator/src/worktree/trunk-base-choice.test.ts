import { expect, test } from 'bun:test'
import { chooseTrunkBase, type TrunkBaseFacts } from './trunk-base-choice.ts'

const MAIN_AT_TRUNK: TrunkBaseFacts = {
  explicitBase: false,
  carry: false,
  callerIsRegisteredMain: true,
  callerBranch: 'main',
  landingBranch: 'main',
  callerHead: 'local-head',
  upstreamRef: 'origin/main',
  upstreamTip: 'upstream-tip',
  behindByFastForward: true,
  commitsBehind: 3,
}

const facts = (over: Partial<TrunkBaseFacts> = {}): TrunkBaseFacts => ({
  ...MAIN_AT_TRUNK,
  ...over,
})

test('a main checkout a fast-forward behind its upstream starts from the upstream tip', () => {
  expect(chooseTrunkBase(facts())).toEqual({
    base: 'upstream-tip',
    reason: 'upstream',
    upstreamRef: 'origin/main',
    behind: 3,
  })
})

test('a trunk already at the upstream tip keeps its own HEAD', () => {
  expect(
    chooseTrunkBase(
      facts({ upstreamTip: 'local-head', behindByFastForward: false, commitsBehind: 0 }),
    ),
  ).toEqual({ base: null, reason: 'at-upstream', upstreamRef: null, behind: 0 })
})

test('a trunk ahead of, or diverged from, its upstream keeps its own HEAD', () => {
  expect(chooseTrunkBase(facts({ behindByFastForward: false, commitsBehind: 0 }))).toEqual({
    base: null,
    reason: 'not-fast-forward',
    upstreamRef: null,
    behind: 0,
  })
})

test('an explicitly named base stands even when the trunk is behind', () => {
  expect(chooseTrunkBase(facts({ explicitBase: true }))).toEqual({
    base: null,
    reason: 'explicit-base',
    upstreamRef: null,
    behind: 0,
  })
})

test('--carry keeps the caller HEAD as the base even when the trunk is behind', () => {
  expect(chooseTrunkBase(facts({ carry: true }))).toEqual({
    base: null,
    reason: 'carry',
    upstreamRef: null,
    behind: 0,
  })
})

test('a caller that is a worktree rather than the main checkout keeps its own HEAD', () => {
  expect(chooseTrunkBase(facts({ callerIsRegisteredMain: false }))).toEqual({
    base: null,
    reason: 'not-registered-main-checkout',
    upstreamRef: null,
    behind: 0,
  })
})

test('a main checkout on another branch keeps its own HEAD', () => {
  expect(chooseTrunkBase(facts({ callerBranch: 'DEV-1513-topic' }))).toEqual({
    base: null,
    reason: 'not-on-landing-branch',
    upstreamRef: null,
    behind: 0,
  })
  expect(chooseTrunkBase(facts({ callerBranch: null }))).toEqual({
    base: null,
    reason: 'not-on-landing-branch',
    upstreamRef: null,
    behind: 0,
  })
})

test('an upstream that does not resolve keeps the caller HEAD', () => {
  expect(chooseTrunkBase(facts({ upstreamRef: null }))).toEqual({
    base: null,
    reason: 'no-upstream',
    upstreamRef: null,
    behind: 0,
  })
  expect(chooseTrunkBase(facts({ upstreamTip: null }))).toEqual({
    base: null,
    reason: 'no-upstream',
    upstreamRef: null,
    behind: 0,
  })
})

test('an unreadable caller HEAD leaves the base unresolved', () => {
  expect(chooseTrunkBase(facts({ callerHead: null }))).toEqual({
    base: null,
    reason: 'unresolved-head',
    upstreamRef: null,
    behind: 0,
  })
})
