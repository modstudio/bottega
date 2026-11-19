import { expect, test } from 'bun:test'
import { developerNodeNotice } from './developer-node.ts'

test.each([
  ['checkout', '/bin/node', '24.0.0', null],
  ['checkout', '/bin/node', '26.1.0', null],
  ['distribution', '/bin/node', '22.23.5', null],
  [null, '/bin/node', '22.23.5', null],
] as const)(
  'developer Node notice for %s at %s with %s',
  (installationKind, nodePath, nodeVersion, expected) => {
    expect(developerNodeNotice({ installationKind, nodePath, nodeVersion })).toBe(expected)
  },
)

test('checkout with old Node gets the gate prerequisite notice', () => {
  expect(
    developerNodeNotice({
      installationKind: 'checkout',
      nodePath: '/bin/node',
      nodeVersion: '22.23.5',
    }),
  ).toEqual({
    message: "Node 22.23.5 is older than Node 24, which the gate's architecture checks need",
    fix: 'install Node 24 or later',
  })
})

test('checkout without Node gets the absent prerequisite notice', () => {
  expect(
    developerNodeNotice({ installationKind: 'checkout', nodePath: null, nodeVersion: null }),
  ).toEqual({
    message: "Node is not on PATH; the gate's architecture checks need Node 24 or later",
    fix: 'install Node 24 or later',
  })
})

test('checkout whose Node version probe fails gets a repair notice', () => {
  expect(
    developerNodeNotice({
      installationKind: 'checkout',
      nodePath: '/usr/local/bin/node',
      nodeVersion: null,
    }),
  ).toEqual({
    message:
      "node --version failed at /usr/local/bin/node; the gate's architecture checks need Node 24 or later",
    fix: 'install Node 24 or later, or repair the node on PATH',
  })
})

test('checkout whose Node version is unreadable gets a repair notice', () => {
  expect(
    developerNodeNotice({
      installationKind: 'checkout',
      nodePath: '/usr/local/bin/node',
      nodeVersion: 'unknown',
    }),
  ).toEqual({
    message:
      "could not read a Node version from /usr/local/bin/node; the gate's architecture checks need Node 24 or later",
    fix: 'install Node 24 or later, or repair the node on PATH',
  })
})
