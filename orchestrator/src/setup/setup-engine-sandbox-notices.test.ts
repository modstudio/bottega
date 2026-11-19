import { expect, test } from 'bun:test'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { proposeSetup } from './setup-engine.ts'
import type { SetupFacts } from './setup-facts.ts'

const runtime = {
  available: false,
  location: '/runtime',
  missingSystemDependencies: [],
  condition: 'sandbox namespaces are blocked',
  remedy: '',
  fixes: ['install profile', 'reload AppArmor'],
  sandboxProbeUnavailableReason: null,
}

function notices(machineLevel: SetupFacts['machineLevel'], available = false) {
  const facts = {
    machineLevel,
    git: { path: '/bin/git', version: '1' },
    gh: { path: '/bin/gh', version: '1', loggedIn: true },
    sandboxRuntime: { ...runtime, available },
  } as unknown as SetupFacts
  return proposeSetup(resolveWorktreeLifecycle, facts, [], [], [], [], []).notices
}

test('notices each unavailable sandbox fix only for full machine setup', () => {
  expect(notices('full')).toEqual([
    { message: runtime.condition, fix: 'install profile', blocking: false },
    { message: runtime.condition, fix: 'reload AppArmor', blocking: false },
  ])
  expect(notices(null)).toHaveLength(2)
  expect(notices('record')).toEqual([])
  expect(notices('full', true)).toEqual([])
})
