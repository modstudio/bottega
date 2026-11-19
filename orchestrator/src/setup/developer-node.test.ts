import { expect, test } from 'bun:test'
import { developerNodeNotice } from './developer-node.ts'

test.each([
  ['checkout', 'v24.0.0', null],
  ['checkout', 'v26.1.0', null],
  ['distribution', 'v22.23.5', null],
  [null, 'v22.23.5', null],
] as const)('developer Node notice for %s with %s', (installationKind, nodeVersion, expected) => {
  expect(developerNodeNotice({ installationKind, nodeVersion })).toBe(expected)
})

test('checkout with old Node gets the gate prerequisite notice', () => {
  expect(developerNodeNotice({ installationKind: 'checkout', nodeVersion: 'v22.23.5' })).toEqual({
    message: "Node v22.23.5 is older than Node 24, which the gate's architecture checks need",
    fix: 'install Node 24 or later',
  })
})

test('checkout without Node gets the absent prerequisite notice', () => {
  expect(developerNodeNotice({ installationKind: 'checkout', nodeVersion: null })).toEqual({
    message: "Node is not on PATH; the gate's architecture checks need Node 24 or later",
    fix: 'install Node 24 or later',
  })
})
