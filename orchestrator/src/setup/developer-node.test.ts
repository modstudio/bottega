import { expect, test } from 'bun:test'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { developerNodeNotice } from './developer-node.ts'
import { proposeSetup } from './setup-engine.ts'
import type { SetupFacts } from './setup-facts.ts'

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

test('checkout whose Node version cannot be read gets a repair notice', () => {
  expect(
    developerNodeNotice({
      installationKind: 'checkout',
      nodePath: '/usr/local/bin/node',
      nodeVersion: null,
    }),
  ).toEqual({
    message:
      "could not read a Node version from /usr/local/bin/node; the gate's architecture checks need Node 24 or later",
    fix: 'install Node 24 or later, or repair the node on PATH',
  })
})

test('setup plans a non-blocking old-Node notice only for a checkout', () => {
  const facts = {
    machineLevel: 'full',
    node: { path: '/bin/node', version: '22.23.5' },
    git: { path: '/bin/git', version: '2.51.0' },
    gh: { path: '/bin/gh', version: '2.80.0', loggedIn: true },
    sandboxRuntime: { available: true },
    os: { platform: 'linux', arch: 'x64', wsl: false },
  } as SetupFacts
  const plan = (installationKind: SetupFacts['installationKind']) =>
    proposeSetup(resolveWorktreeLifecycle, { ...facts, installationKind }, [], [], [], [], [])

  expect(plan('checkout').notices).toContainEqual({
    message: "Node 22.23.5 is older than Node 24, which the gate's architecture checks need",
    fix: 'install Node 24 or later',
    blocking: false,
  })
  expect(plan('distribution').notices).toEqual([])
})
