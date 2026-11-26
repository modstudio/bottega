import { expect, test } from 'bun:test'
import type { SetupPlan } from './setup-engine.ts'
import { planSetupActions } from './setup-planner.ts'

test('install verification follows environment migration and machine value changes', () => {
  const plan: SetupPlan = {
    facts: {
      machine: { machineLevel: null, globalUse: 'off' } as SetupPlan['facts']['machine'],
      repositories: [],
    },
    proposals: [],
    registrations: [],
    questions: [],
    notices: [],
    folderSelection: { options: [], defaults: [] },
  }

  expect(
    planSetupActions(plan, {
      'machine:global-use': 'on',
      'machine:level': 'full',
    }).map((action) => action.kind),
  ).toEqual(['migrate-environment', 'set-global-use', 'set-machine-level', 'install-verify'])
})

test('accepted declared-agent actions register before probing', () => {
  const plan = {
    facts: { machine: { globalUse: null }, repositories: [] },
    proposals: [],
    registrations: [],
    questions: [],
    notices: [],
    folderSelection: { options: [], defaults: [] },
    agentDeclarations: {
      registrations: [{ name: 'new', mutation: { harness: 'codex' } }],
      disablements: [],
      existingProbeNames: ['existing'],
      projectPath: '/project',
      spaceSlug: 'team',
    },
  } as unknown as SetupPlan

  expect(
    planSetupActions(plan, {
      'register-agents': 'register',
      'probe-agents': 'probe',
    }).slice(-2),
  ).toEqual([
    expect.objectContaining({ kind: 'register-agents' }),
    { kind: 'probe-agents', names: ['existing', 'new'], projectPath: '/project' },
  ])
})

test('accepted space disablement becomes one action', () => {
  const plan = {
    facts: { machine: { globalUse: null }, repositories: [] },
    proposals: [],
    registrations: [],
    questions: [],
    notices: [],
    folderSelection: { options: [], defaults: [] },
    agentDeclarations: {
      registrations: [],
      disablements: [{ name: 'grok', reason: 'subscription ended' }],
      existingProbeNames: [],
      projectPath: null,
      spaceSlug: 'team',
    },
  } as unknown as SetupPlan

  expect(planSetupActions(plan, { 'apply-space-disabled': 'apply' })).toContainEqual({
    kind: 'disable-agents',
    agents: [{ name: 'grok', reason: 'subscription ended' }],
  })
})
