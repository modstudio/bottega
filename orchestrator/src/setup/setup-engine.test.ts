import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import type { Project, ProjectSettings } from '../project/projects.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import type { RepositoryFacts } from './repository-facts.ts'
import {
  deriveKeyPrefix,
  proposeSetup as proposeSetupEngine,
  type SetupAgent,
  type SetupNotice,
} from './setup-engine.ts'
import type { SetupFacts } from './setup-facts.ts'
import { legacyMcpServerName, type McpServer } from './setup-mcp.ts'
import { planSetupActions, recommendedAnswers, validateSetupAnswers } from './setup-planner.ts'
import { INFERRED_RECIPE_PATH, inferredRecipeContent } from './setup-toolchain.ts'

const FRONT_DOOR = join('/', 'bin', PLATFORM_SLUG)

const plannedAction = (
  plan: Parameters<typeof planSetupActions>[0],
  answers: Parameters<typeof planSetupActions>[1],
) => {
  const actions = planSetupActions(plan, answers)
  return actions.find((action) => action.kind !== 'migrate-environment')
}

function proposeSetup(
  facts: SetupFacts,
  repositories: RepositoryFacts[],
  register: Project[],
  agents: SetupAgent[],
  notices: SetupNotice[] = [],
  servers: Parameters<typeof proposeSetupEngine>[6] = [],
) {
  return proposeSetupEngine(
    resolveWorktreeLifecycle,
    facts,
    repositories,
    register,
    agents,
    notices,
    servers,
  )
}

const machine = {
  recordApiUrl: 'https://api.example.test',
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

test('mentions record use when no hosted record address is configured', () => {
  const plan = proposeSetup({ ...machine, recordApiUrl: null }, [], [], [])
  expect(plan.notices).toContainEqual({
    message: 'hosted record address is not configured',
    fix: `${PLATFORM_SLUG} record use <address>`,
  })
})

const orchServer: McpServer = {
  name: MCP_SERVER_NAME,
  command: FRONT_DOOR,
  args: ['mcp'],
}
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
    packageManager: null,
    lint: null,
    typecheck: null,
    test: null,
    ci: false,
    defaultConfigExists: false,
    inferredRecipeFile: { status: 'absent', content: null, reason: null },
    ...overrides,
  }
}

function registered(settings: Project['settings'], overrides: Partial<Project> = {}): Project {
  return {
    recordId: '01990000-0000-7000-8000-000000001214',
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
  expect(plannedAction(addPlan, recommendedAnswers(addPlan))?.kind).toBe('add')
  const currentSettings = {
    keyPrefixes: ['ALPHA'],
    tracker: { kind: 'hub', protocol: 'hub' } as const,
    trunk: 'main',
  }
  const unchangedPlan = proposeSetup(machine, [repository()], [registered(currentSettings)], [])
  expect(plannedAction(unchangedPlan, recommendedAnswers(unchangedPlan))).toMatchObject({
    kind: 'unchanged',
    settingsDiff: {},
  })
  const setPlan = proposeSetup(machine, [repository()], [registered({})], [])
  expect(plannedAction(setPlan, recommendedAnswers(setPlan))).toMatchObject({
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
    [
      repository({
        currentBranch: 'feature',
        remoteDefaultBranch: 'main',
        stack: 'node',
      }),
    ],
    [current],
    [],
  )
  expect(plan.questions).toEqual([])
  expect(plan.notices).toEqual([
    expect.objectContaining({
      message: 'no gate was detected for alpha-project',
    }),
  ])
  expect(plannedAction(plan, recommendedAnswers(plan))).toMatchObject({
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
  const action = plannedAction(plan, recommendedAnswers(plan))
  expect(action).toMatchObject({
    kind: 'set',
    currentName: 'registered-name',
    fill: { settings: { keyPrefixes: ['ALPHA'] } },
  })
  expect(action?.kind).toBe('set')
  if (action?.kind === 'set')
    expect(action.settingsDiff).toEqual({
      keyPrefixes: { from: null, to: ['ALPHA'] },
    })
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
  const differingAction = plannedAction(differing, recommendedAnswers(differing))
  expect(differingAction?.kind).toBe('add')
  if (differingAction?.kind === 'add') expect(differingAction.settings).not.toHaveProperty('trunk')
  const detached = proposeSetup(machine, [repository({ currentBranch: null })], [], [])
  expect(detached.questions.filter((question) => question.id.endsWith(':trunk'))).toHaveLength(0)
  expect(detached.notices[0]?.message).toContain('detached HEAD')
})

test('reports a bounded git inspection timeout as a repository notice', () => {
  const plan = proposeSetup(machine, [repository({ inspectionTimedOut: true })], [], [])
  expect(plan.notices).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining('alpha-project'),
    }),
  )
  expect(plan.notices[0]?.message).toContain('timed out')
})

test('proposes a detected gate and Files-level recipe through fill-absent planning', () => {
  const facts = repository({
    packageManager: 'pnpm',
    lint: 'pnpm lint',
    typecheck: 'pnpm typecheck',
    test: 'pnpm test',
  })
  const plan = proposeSetup(
    machine,
    [facts],
    [
      registered({
        keyPrefixes: ['ALPHA'],
        trunk: 'main',
        worktree: {
          branch: 'orch/{id}',
          readonly_provision: [{ path: 'node_modules', method: 'link' }],
        },
      }),
    ],
    [],
  )
  const recipeQuestion = plan.questions.find((question) => question.id.endsWith(':worktree-recipe'))
  expect(recipeQuestion).toMatchObject({ recommendation: 'write' })
  const action = plannedAction(plan, recommendedAnswers(plan))
  expect(action).toMatchObject({
    kind: 'set',
    fill: {
      settings: {
        gate: 'pnpm lint && pnpm typecheck && pnpm test',
        worktree: { recipePath: INFERRED_RECIPE_PATH },
      },
    },
    recipeFile: { path: INFERRED_RECIPE_PATH },
  })
  expect(action?.kind).toBe('set')
  if (action?.kind === 'set') {
    expect(action.fill.settings.worktree).toEqual({
      recipePath: INFERRED_RECIPE_PATH,
    })
  }
})

test('does not propose an existing gate or ask for an existing recipe', () => {
  const current = registered({
    keyPrefixes: ['ALPHA'],
    tracker: { kind: 'hub', protocol: 'hub' },
    trunk: 'main',
    gate: 'make check',
    worktree: { recipePath: 'custom.jsonc' },
  })
  const plan = proposeSetup(
    machine,
    [repository({ packageManager: 'bun', test: 'bun run test' })],
    [current],
    [],
  )
  expect(plan.questions.some((question) => question.id.endsWith(':worktree-recipe'))).toBe(false)
  expect(plannedAction(plan, recommendedAnswers(plan))).toMatchObject({
    kind: 'unchanged',
  })

  const filePlan = proposeSetup(
    machine,
    [
      repository({
        packageManager: 'bun',
        test: 'bun run test',
        defaultConfigExists: true,
      }),
    ],
    [
      registered({
        keyPrefixes: ['ALPHA'],
        tracker: { kind: 'hub', protocol: 'hub' },
        trunk: 'main',
        gate: 'make check',
      }),
    ],
    [],
  )
  expect(filePlan.questions.some((question) => question.id.endsWith(':worktree-recipe'))).toBe(
    false,
  )
})

const satisfiedLifecycleCases: [string, ProjectSettings['worktree'] | undefined, boolean][] = [
  ['command templates', { create: { command: 'make', args: ['worktree'] } }, false],
  ['inline recipe', { recipe: {} }, false],
  ['default config', undefined, true],
]

test.each(satisfiedLifecycleCases)(
  'treats %s lifecycle as already satisfied',
  (_name, worktree, defaultConfigExists) => {
    const plan = proposeSetup(
      machine,
      [
        repository({
          packageManager: 'bun',
          test: 'bun run test',
          defaultConfigExists,
        }),
      ],
      [
        registered({
          keyPrefixes: ['ALPHA'],
          tracker: { kind: 'hub', protocol: 'hub' },
          trunk: 'main',
          gate: 'bun run test',
          ...(worktree ? { worktree } : {}),
        }),
      ],
      [],
    )
    expect(plan.questions.some((question) => question.id.endsWith(':worktree-recipe'))).toBe(false)
    expect(plannedAction(plan, recommendedAnswers(plan))).toMatchObject({
      kind: 'unchanged',
    })
  },
)

test('recovers an existing inferred recipe by filling only its pointer', () => {
  const detected = repository({ packageManager: 'bun', test: 'bun run test' })
  const plan = proposeSetup(
    machine,
    [
      repository({
        packageManager: 'bun',
        test: 'bun run test',
        inferredRecipeFile: {
          status: 'regular',
          content: inferredRecipeContent(detected)!,
          reason: null,
        },
      }),
    ],
    [
      registered({
        keyPrefixes: ['ALPHA'],
        tracker: { kind: 'hub', protocol: 'hub' },
        trunk: 'main',
        gate: 'bun run test',
        worktree: { branch: 'orch/{id}' },
      }),
    ],
    [],
  )
  expect(plan.questions.some((question) => question.id.endsWith(':worktree-recipe'))).toBe(false)
  expect(plannedAction(plan, recommendedAnswers(plan))).toMatchObject({
    kind: 'set',
    fill: { settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } } },
  })
  expect(plannedAction(plan, recommendedAnswers(plan))).not.toHaveProperty('recipeFile')
})

test('requires review before activating a modified inferred recipe', () => {
  const plan = proposeSetup(
    machine,
    [
      repository({
        packageManager: 'bun',
        test: 'bun run test',
        inferredRecipeFile: {
          status: 'regular',
          content:
            '{"worktree":{"create":[{"name":"custom","run":{"command":"sh","args":["custom.sh"]}}]}}\n',
          reason: null,
        },
      }),
    ],
    [
      registered({
        keyPrefixes: ['ALPHA'],
        tracker: { kind: 'hub', protocol: 'hub' },
        trunk: 'main',
        gate: 'bun run test',
      }),
    ],
    [],
  )
  const question = plan.questions.find((candidate) => candidate.id.endsWith(':worktree-recipe'))!
  expect(question.recommendation).toBe('keep-inactive')
  expect(question.question).toContain('custom.sh')
  expect(plannedAction(plan, recommendedAnswers(plan))).toMatchObject({
    kind: 'unchanged',
  })

  const activate = { ...recommendedAnswers(plan), [question.id]: 'activate' }
  expect(plannedAction(plan, activate)).toMatchObject({
    kind: 'set',
    fill: { settings: { worktree: { recipePath: INFERRED_RECIPE_PATH } } },
  })
  expect(plannedAction(plan, activate)).not.toHaveProperty('recipeFile')
})

test('refuses an unsafe inferred recipe without offering activation', () => {
  const plan = proposeSetup(
    machine,
    [
      repository({
        packageManager: 'bun',
        inferredRecipeFile: {
          status: 'unsafe',
          content: null,
          reason: `${INFERRED_RECIPE_PATH} parent is a symbolic link`,
        },
      }),
    ],
    [],
    [],
  )
  expect(plan.questions.some((question) => question.id.endsWith(':worktree-recipe'))).toBe(false)
  expect(plan.notices.some((notice) => notice.message.includes('symbolic link'))).toBe(true)
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
    validateSetupAnswers(plan.questions, {
      ...recommendedAnswers(plan),
      unknown: 'value',
    }),
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
      registrations: { [MCP_SERVER_NAME]: { status: 'absent' } },
    }),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(absent.questions).toHaveLength(1)
  expect(plannedAction(absent, recommendedAnswers(absent))).toMatchObject({
    kind: 'register-mcp',
    replace: false,
  })

  const same = proposeSetup(
    machineWithMcp('codex', {
      support: 'automatic',
      registrations: {
        [MCP_SERVER_NAME]: { status: 'registered', command: FRONT_DOOR, args: ['mcp'] },
      },
    }),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(same.questions).toEqual([])
  expect(plannedAction(same, recommendedAnswers(same))?.kind).toBe('mcp-unchanged')

  const different = proposeSetup(
    machineWithMcp('codex', {
      support: 'automatic',
      registrations: {
        [MCP_SERVER_NAME]: {
          status: 'different',
          command: '/old/orch',
          args: ['mcp'],
          detail: 'registered command or arguments differ',
        },
      },
    }),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(different.questions[0]).toMatchObject({ recommendation: 'keep' })
  expect(plannedAction(different, recommendedAnswers(different))?.kind).toBe('mcp-skipped')
  expect(plannedAction(different, { [different.questions[0]!.id]: 'replace' })).toMatchObject({
    kind: 'register-mcp',
    replace: true,
  })
})

test('recommends renaming legacy Claude and Codex registrations to stable registrations', () => {
  const workerServer: McpServer = {
    name: WORKER_MCP_SERVER_NAME,
    command: `/bin/${PLATFORM_SLUG}`,
    args: ['mcp', 'ask-server'],
  }
  const cases = [
    {
      harness: 'claude' as const,
      server: orchServer,
      legacy: {
        status: 'registered' as const,
        command: '/legacy/orch',
        args: ['mcp'],
      },
    },
    {
      harness: 'codex' as const,
      server: workerServer,
      legacy: {
        status: 'registered' as const,
        command: `/bin/${PLATFORM_SLUG}`,
        args: ['mcp', 'ask-server'],
      },
    },
  ]

  for (const { harness, server, legacy } of cases) {
    const legacyName = legacyMcpServerName(server.name)
    const plan = proposeSetup(
      machineWithMcp(harness, {
        support: 'automatic',
        registrations: { [server.name]: { status: 'absent' } },
        legacyRegistrations: { [legacyName]: legacy },
      }),
      [],
      [],
      [],
      [],
      [server],
    )

    expect(plan.questions).toHaveLength(1)
    expect(plan.questions[0]).toMatchObject({
      question: expect.stringContaining(`Rename the legacy ${legacyName}`),
      recommendation: 'replace',
    })
    expect(plannedAction(plan, recommendedAnswers(plan))).toMatchObject({
      kind: 'register-mcp',
      server,
      legacyName,
      replace: true,
    })
  }
})

test('recommends skipping an absent registration when the harness is signed out', () => {
  const plan = proposeSetup(
    machineWithMcp(
      'codex',
      { support: 'automatic', registrations: { [MCP_SERVER_NAME]: { status: 'absent' } } },
      'signed-out',
    ),
    [],
    [],
    [],
    [],
    [orchServer],
  )
  expect(plan.questions[0]?.recommendation).toBe('skip')
  expect(plannedAction(plan, recommendedAnswers(plan))?.kind).toBe('mcp-skipped')
})

test('emits manual MCP instructions for an installed harness without CLI support', () => {
  const plan = proposeSetup(
    machineWithMcp('goose', { support: 'manual', registrations: {} }),
    [],
    [],
    [{ name: 'goose', harness: 'goose', enabled: true, probePassed: false }],
    [],
    [orchServer],
  )
  expect(plan.questions).toEqual([])
  expect(plan.notices[0]).toMatchObject({
    message: expect.stringContaining('goose'),
    fix: expect.stringContaining(`${PLATFORM_SLUG} mcp serve --config`),
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

const agent = (name: string, enabled = true, harness = name, probePassed = true): SetupAgent => ({
  name,
  harness,
  enabled,
  probePassed,
})

test('notices when an enabled built-in agent harness is absent', () => {
  const plan = proposeSetup(machineWithHarness('codex', null, 'unknown'), [], [], [agent('codex')])
  expect(plan.questions).toEqual([])
  expect(plan.notices).toEqual([
    {
      message: 'codex agent is enabled but the codex harness is not installed',
      fix: `install codex, or ${PLATFORM_SLUG} agent set codex --enabled false --reason "codex is not installed on this machine"`,
    },
  ])
})

test('notices when an enabled built-in agent harness is not signed in', () => {
  const plan = proposeSetup(
    machineWithHarness('grok', '/bin/grok', 'signed-out'),
    [],
    [],
    [agent('grok', true, 'grok', false)],
  )
  expect(plan.notices).toEqual([
    {
      message: 'grok agent is enabled but the grok harness is not signed in',
      fix: `sign in to grok, or ${PLATFORM_SLUG} agent set grok --enabled false --reason "grok is not signed in on this machine"`,
    },
  ])
})

test('notices separately when an enabled built-in harness sign-in state is unknown', () => {
  const plan = proposeSetup(
    machineWithHarness('codex', '/bin/codex', 'unknown'),
    [],
    [],
    [agent('codex')],
  )
  expect(plan.notices).toEqual([
    {
      message: 'the sign-in state of codex could not be established',
      fix: `check codex sign-in and re-run ${PLATFORM_SLUG} machine setup plan`,
    },
  ])
})

test('does not notice a disabled built-in agent when harness sign-in state is unknown', () => {
  const plan = proposeSetup(
    machineWithHarness('grok', '/bin/grok', 'unknown'),
    [],
    [],
    [agent('grok', false)],
  )
  expect(plan.notices).toEqual([])
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
      fix: `${PLATFORM_SLUG} agent set codex --enabled true`,
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

test('notices when an installed signed-in built-in has not passed its probe', () => {
  const plan = proposeSetup(
    machineWithHarness('codex', '/bin/codex', 'signed-in'),
    [],
    [],
    [agent('codex', true, 'codex', false)],
  )
  expect(plan.notices).toEqual([
    {
      message:
        'codex harness is installed and signed in but the codex agent cannot take repository work until it is probed',
      fix: `${PLATFORM_SLUG} agent probe codex`,
    },
  ])
})

test('does not show the probe notice after a built-in passes its probe', () => {
  const plan = proposeSetup(
    machineWithHarness('codex', '/bin/codex', 'signed-in'),
    [],
    [],
    [agent('codex', true, 'codex', true)],
  )
  expect(plan.notices).toEqual([])
})

test('notices an installed unregistered non-built-in harness without guessing a model', () => {
  const plan = proposeSetup(machineWithHarness('goose', '/bin/goose', 'unknown'), [], [], [])
  expect(plan.notices).toEqual([
    {
      message: 'goose harness is installed but unregistered',
      fix: `${PLATFORM_SLUG} agent add <name> --harness goose --backend <backend> --model <model>`,
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
