import { expect, test } from 'bun:test'
import type { Project } from '../project/projects.ts'
import type { RepositoryFacts } from './repository-facts.ts'
import { deriveKeyPrefix, proposeSetup, type SetupAgent } from './setup-engine.ts'
import type { SetupFacts } from './setup-facts.ts'
import { planSetupActions, recommendedAnswers, validateSetupAnswers } from './setup-planner.ts'

const machine = {
  git: { path: '/bin/git', version: '1' },
  gh: { path: '/bin/gh', version: '1', loggedIn: true },
} as SetupFacts

function machineWithMcp(
  harness: 'claude' | 'codex' | 'grok' | 'opencode' | 'goose',
  mcp: NonNullable<SetupFacts['harnesses']['codex']['mcp']>,
  auth: SetupFacts['harnesses']['codex']['auth'] = 'signed-in',
): SetupFacts {
  return {
    ...machine,
    harnesses: Object.fromEntries(
      ['claude', 'codex', 'grok', 'opencode', 'goose'].map((name) => [
        name,
        {
          path: name === harness ? `/bin/${name}` : null,
          version: name === harness ? '1' : null,
          auth,
          mcp: name === harness ? mcp : null,
        },
      ]),
    ) as SetupFacts['harnesses'],
  }
}

const orchServer = { name: 'orch' as const, command: '/bin/orch', args: ['mcp'] }

function repository(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return {
    name: 'alpha-project',
    path: '/repos/alpha-project',
    currentBranch: 'main',
    clean: true,
    originUrl: 'git@github.com:owner/alpha-project.git',
    originHost: 'github.com',
    remoteDefaultBranch: 'main',
    stack: 'node',
    inspectionTimedOut: false,
    ...overrides,
  }
}

function registered(settings: Project['settings'], overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'alpha-project',
    path: '/repos/alpha-project',
    stack: 'node',
    canon: true,
    retiredAt: null,
    settings,
    ...overrides,
  }
}

test('plans add, set, and unchanged from fixture facts', () => {
  const addPlan = proposeSetup(machine, [repository()], [], [])
  expect(planSetupActions(addPlan, recommendedAnswers(addPlan))[0]?.kind).toBe('add')
  const currentSettings = {
    keyPrefixes: ['ALPHA'],
    tracker: { kind: 'hub', protocol: 'hub' } as const,
    trunk: 'main',
  }
  const unchangedPlan = proposeSetup(machine, [repository()], [registered(currentSettings)], [])
  expect(planSetupActions(unchangedPlan, recommendedAnswers(unchangedPlan))[0]).toMatchObject({
    kind: 'unchanged',
    settingsDiff: {},
  })
  const setPlan = proposeSetup(machine, [repository()], [registered({})], [])
  expect(planSetupActions(setPlan, recommendedAnswers(setPlan))[0]).toMatchObject({
    kind: 'set',
    settingsDiff: {
      keyPrefixes: { from: null, to: ['ALPHA'] },
      tracker: { from: null, to: { kind: 'hub', protocol: 'hub' } },
      trunk: { from: null, to: 'main' },
    },
  })
})

test('preserves every configured value for an existing project', () => {
  const current = registered(
    {
      keyPrefixes: ['KEEP'],
      tracker: { kind: 'linear', team: 'existing' },
      trunk: 'develop',
    },
    { name: 'registered-name', stack: 'php' },
  )
  const plan = proposeSetup(
    machine,
    [repository({ currentBranch: 'feature', remoteDefaultBranch: 'main', stack: 'node' })],
    [current],
    [],
  )
  expect(plan.questions).toEqual([])
  expect(plan.notices).toEqual([])
  expect(planSetupActions(plan, recommendedAnswers(plan))[0]).toMatchObject({
    kind: 'unchanged',
    name: 'registered-name',
    settingsDiff: {},
  })
})

test('fills only a missing prefix without changing the registered name', () => {
  const current = registered(
    { tracker: { kind: 'linear', team: 'existing' }, trunk: 'main' },
    { name: 'registered-name' },
  )
  const plan = proposeSetup(machine, [repository()], [current], [])
  expect(plan.questions).toHaveLength(1)
  expect(plan.questions[0]?.id).toEndWith(':key-prefix')
  const action = planSetupActions(plan, recommendedAnswers(plan))[0]
  expect(action).toMatchObject({
    kind: 'set',
    currentName: 'registered-name',
    fill: { settings: { keyPrefixes: ['ALPHA'] } },
  })
  expect(action?.kind).toBe('set')
  if (action?.kind === 'set')
    expect(action.settingsDiff).toEqual({ keyPrefixes: { from: null, to: ['ALPHA'] } })
})

test('asks about trunk only when known branches disagree', () => {
  const same = proposeSetup(machine, [repository()], [], [])
  expect(same.questions.filter((question) => question.id.endsWith(':trunk'))).toHaveLength(0)
  expect(same.proposals[0]?.project.settings.trunk).toBe('main')
  const differing = proposeSetup(
    machine,
    [repository({ currentBranch: 'feature', remoteDefaultBranch: 'main' })],
    [],
    [],
  )
  expect(differing.questions.find((question) => question.id.endsWith(':trunk'))).toMatchObject({
    recommendation: 'unset',
  })
  expect(differing.notices[0]?.message).toContain('check out main')
  const differingAction = planSetupActions(differing, recommendedAnswers(differing))[0]
  expect(differingAction?.kind).toBe('add')
  if (differingAction?.kind === 'add') expect(differingAction.settings).not.toHaveProperty('trunk')
  const detached = proposeSetup(machine, [repository({ currentBranch: null })], [], [])
  expect(detached.questions.filter((question) => question.id.endsWith(':trunk'))).toHaveLength(0)
  expect(detached.notices[0]?.message).toContain('detached HEAD')
})

test('reports a bounded git inspection timeout as a repository notice', () => {
  const plan = proposeSetup(machine, [repository({ inspectionTimedOut: true })], [], [])
  expect(plan.notices).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining('alpha-project') }),
  )
  expect(plan.notices[0]?.message).toContain('timed out')
})

test('derives bounded unique prefixes and excludes TASK', () => {
  expect(deriveKeyPrefix('alpha-project', new Set())).toBe('ALPHA')
  const collision = deriveKeyPrefix('alpha-project', new Set(['ALPHA']))
  expect(collision).not.toBe('ALPHA')
  expect(collision).toHaveLength(5)
  expect(deriveKeyPrefix('task', new Set())).toBe('TASK1')
})

test('answers validation refuses unknown, missing, and invalid options', () => {
  const plan = proposeSetup(machine, [repository()], [], [])
  expect(() => validateSetupAnswers(plan.questions, {})).toThrow('missing answer')
  expect(() =>
    validateSetupAnswers(plan.questions, { ...recommendedAnswers(plan), unknown: 'value' }),
  ).toThrow('unknown answer id')
  expect(() =>
    validateSetupAnswers(plan.questions, {
      ...recommendedAnswers(plan),
      [plan.questions[0]!.id]: 'invalid',
    }),
  ).toThrow('invalid option')
})

test('plans absent, same, and different MCP registration read-backs', () => {
  const absent = proposeSetup(
    machineWithMcp('codex', {
      support: 'automatic',
      registrations: { orch: { status: 'absent' } },
    }),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(absent.questions).toHaveLength(1)
  expect(planSetupActions(absent, recommendedAnswers(absent))[0]).toMatchObject({
    kind: 'register-mcp',
    replace: false,
  })

  const same = proposeSetup(
    machineWithMcp('codex', {
      support: 'automatic',
      registrations: { orch: { status: 'registered', command: '/bin/orch', args: ['mcp'] } },
    }),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(same.questions).toEqual([])
  expect(planSetupActions(same, recommendedAnswers(same))[0]?.kind).toBe('mcp-unchanged')

  const different = proposeSetup(
    machineWithMcp('codex', {
      support: 'automatic',
      registrations: { orch: { status: 'registered', command: '/old/orch', args: ['mcp'] } },
    }),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(different.questions[0]).toMatchObject({ recommendation: 'keep' })
  expect(planSetupActions(different, recommendedAnswers(different))[0]?.kind).toBe('mcp-skipped')
  expect(planSetupActions(different, { [different.questions[0]!.id]: 'replace' })[0]).toMatchObject(
    { kind: 'register-mcp', replace: true },
  )
})

test('recommends skipping an absent registration when the harness is signed out', () => {
  const plan = proposeSetup(
    machineWithMcp(
      'codex',
      { support: 'automatic', registrations: { orch: { status: 'absent' } } },
      'signed-out',
    ),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(plan.questions[0]?.recommendation).toBe('skip')
  expect(planSetupActions(plan, recommendedAnswers(plan))[0]?.kind).toBe('mcp-skipped')
})

test('emits manual MCP instructions for an installed harness without CLI support', () => {
  const plan = proposeSetup(
    machineWithMcp('goose', { support: 'manual', registrations: {} }),
    [],
    [],
    [{ name: 'goose', harness: 'goose', enabled: true }],
    [],
    [orchServer],
  )
  expect(plan.questions).toEqual([])
  expect(plan.notices[0]).toMatchObject({
    message: expect.stringContaining('goose'),
    fix: expect.stringContaining('orch mcp --config'),
  })
})

function machineWithHarness(
  name: keyof SetupFacts['harnesses'],
  path: string | null,
  auth: SetupFacts['harnesses']['codex']['auth'],
): SetupFacts {
  return {
    ...machine,
    harnesses: {
      claude: { path: null, version: null, auth: 'unknown', mcp: null },
      codex: { path: null, version: null, auth: 'unknown', mcp: null },
      grok: { path: null, version: null, auth: 'unknown', mcp: null },
      opencode: { path: null, version: null, auth: 'unknown', mcp: null },
      goose: { path: null, version: null, auth: 'unknown', mcp: null },
      [name]: { path, version: path ? '1' : null, auth, mcp: null },
    },
  } as SetupFacts
}

const agent = (name: string, enabled = true, harness = name): SetupAgent => ({
  name,
  harness,
  enabled,
})

test('notices when an enabled built-in agent harness is absent', () => {
  const plan = proposeSetup(machineWithHarness('codex', null, 'unknown'), [], [], [agent('codex')])
  expect(plan.questions).toEqual([])
  expect(plan.notices).toEqual([
    {
      message: 'codex agent is enabled but the codex harness is not installed',
      fix: 'install codex, or orch agent set codex --enabled false --reason "codex is not installed on this machine"',
    },
  ])
})

test('notices when an enabled built-in agent harness is not signed in', () => {
  const plan = proposeSetup(
    machineWithHarness('grok', '/bin/grok', 'signed-out'),
    [],
    [],
    [agent('grok')],
  )
  expect(plan.notices).toEqual([
    {
      message: 'grok agent is enabled but the grok harness is not signed in',
      fix: 'sign in to grok, or orch agent set grok --enabled false --reason "grok is not signed in on this machine"',
    },
  ])
})

test('notices when a ready built-in harness has a disabled agent', () => {
  const plan = proposeSetup(
    machineWithHarness('codex', '/bin/codex', 'signed-in'),
    [],
    [],
    [agent('codex', false)],
  )
  expect(plan.notices).toEqual([
    {
      message: 'codex harness is installed and signed in but the codex agent is disabled',
      fix: 'orch agent set codex --enabled true',
    },
  ])
})

test('does not notice a ready enabled built-in agent', () => {
  const plan = proposeSetup(
    machineWithHarness('codex', '/bin/codex', 'signed-in'),
    [],
    [],
    [agent('codex')],
  )
  expect(plan.notices).toEqual([])
})

test('notices an installed unregistered non-built-in harness without guessing a model', () => {
  const plan = proposeSetup(machineWithHarness('goose', '/bin/goose', 'unknown'), [], [], [])
  expect(plan.notices).toEqual([
    {
      message: 'goose harness is installed but unregistered',
      fix: 'orch agent add <name> --harness goose --backend <backend> --model <model>',
    },
  ])
})

test('treats absent harness facts as absent built-in CLIs', () => {
  const plan = proposeSetup(machine, [], [], [agent('codex'), agent('grok')])
  expect(plan.notices.map((notice) => notice.message)).toEqual([
    'codex agent is enabled but the codex harness is not installed',
    'grok agent is enabled but the grok harness is not installed',
  ])
})
