import { expect, test } from 'bun:test'
import { landingTrunkRef, resolveLandingTrunkTip } from './branch-trunk-tip.ts'

test('a fetched trunk at or ahead of the local trunk supplies the landing proof', () => {
  expect(
    landingTrunkRef('main', {
      remoteTrackingRefExists: true,
      localIsAncestorOfRemote: true,
    }),
  ).toBe('origin/main')
})

test('a fetched trunk that does not descend from the local trunk cannot weaken the landing proof', () => {
  expect(
    landingTrunkRef('main', {
      remoteTrackingRefExists: true,
      localIsAncestorOfRemote: false,
    }),
  ).toBe('main')
})

test('a project without a fetched trunk keeps using its local trunk', () => {
  expect(
    landingTrunkRef('main', {
      remoteTrackingRefExists: false,
      localIsAncestorOfRemote: false,
    }),
  ).toBe('main')
})

test('the adapter keeps the local trunk when the fetched trunk has diverged', () => {
  const tip = resolveLandingTrunkTip('main', (args) => {
    if (args[0] === 'show-ref') return ''
    if (args[0] === 'merge-base') throw new Error('not an ancestor')
    return args.at(-1) ?? ''
  })

  expect(tip).toBe('main^{commit}')
})
