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

test('the adapter skips the ancestry probe when no fetched trunk exists', () => {
  const probes: string[][] = []
  const tip = resolveLandingTrunkTip(
    'main',
    (args) => {
      probes.push(args)
      return false
    },
    (ref) => `resolved ${ref}`,
  )

  expect(probes).toEqual([['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']])
  expect(tip).toBe('resolved main^{commit}')
})
