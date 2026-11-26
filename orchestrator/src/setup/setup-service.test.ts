import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { LEGACY_ORCHESTRATOR_DATABASE } from '../../../shared/state-directory.ts'
import type { RecordSpaceAgent } from '../record/record-space-agents.ts'
import type { LocalAgentDeclaration } from './setup-agent-declarations.ts'
import type { SetupPlan } from './setup-engine.ts'
import type { PreparedStateFileMigration } from './setup-environment.ts'
import { LEGACY_MCP_TOOL_PREFIX } from './setup-mcp-config.ts'
import {
  addDeclaredAgentsToPlan,
  addMcpConfigMigrations,
  createSetupService,
  setupAgentsWithDeclarations,
} from './setup-service.ts'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('a malformed project MCP configuration becomes a notice while valid siblings still migrate', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-service-home-'))
  const project = mkdtempSync(join(tmpdir(), 'setup-service-project-'))
  temporary.push(home, project)
  mkdirSync(join(project, '.claude'))
  const malformed = join(project, '.claude', 'settings.json')
  const valid = join(project, '.claude', 'settings.local.json')
  writeFileSync(malformed, '{not json')
  writeFileSync(
    valid,
    JSON.stringify({ permissions: { allow: [`${LEGACY_MCP_TOOL_PREFIX}get_doc`] } }),
  )
  const plan = { notices: [] } as unknown as SetupPlan

  addMcpConfigMigrations(plan, home, [project])

  expect(plan.notices).toHaveLength(1)
  expect(plan.notices[0]?.message).toContain(malformed)
  expect(plan.notices[0]?.message).toContain('JSON')
  expect(plan.notices[0]?.fix).toContain('fix or remove')
  expect(plan.mcpConfigMigrations?.map((migration) => migration.path)).toEqual([valid])
})

const emptyPlan = (): SetupPlan => ({
  facts: { machine: {} as SetupPlan['facts']['machine'], repositories: [] },
  proposals: [],
  registrations: [],
  harnessInstalls: [],
  questions: [],
  notices: [],
  folderSelection: { options: [], defaults: [] },
})

const declarationWith = (overrides: Partial<RecordSpaceAgent> = {}): RecordSpaceAgent => ({
  name: 'codex-team',
  harness: 'codex',
  backend: 'vendor',
  model: 'gpt',
  baseUrl: null,
  transport: 'cli',
  provider: null,
  apiKeySecret: 'team-key',
  requestSettings: null,
  jobs: null,
  preferredJobs: null,
  maxConcurrent: null,
  routeMetered: false,
  trainsOnInputs: false,
  operatedBy: 'vendor',
  billing: 'subscription',
  enabled: true,
  disabledReason: null,
  ...overrides,
})
const declaration = (): RecordSpaceAgent => declarationWith()

test('declared agents are offered for registration and get probe remedies without a project', async () => {
  const plan = emptyPlan()
  await addDeclaredAgentsToPlan(plan, [], [], async () => ({
    kind: 'read',
    space: { id: 'space-a', slug: 'team' },
    agents: [declaration()],
  }))

  expect(plan.questions).toContainEqual(
    expect.objectContaining({
      id: 'register-agents',
      question: 'Register 1 agents the space declares?',
      recommendation: 'register',
    }),
  )
  expect(plan.notices).toContainEqual(
    expect.objectContaining({
      message: 'space agent codex-team cannot be probed because no project is registered',
      fix: `${PLATFORM_SLUG} project add <path>, then ${PLATFORM_SLUG} agent probe codex-team`,
    }),
  )
})

test('a disabled unprobed declared agent is not offered for probing', async () => {
  const plan = emptyPlan()
  const local: LocalAgentDeclaration = {
    ...declaration(),
    enabled: false,
    probedAt: null,
  }
  await addDeclaredAgentsToPlan(
    plan,
    [local],
    [{ path: '/project' }] as Parameters<typeof addDeclaredAgentsToPlan>[2],
    async () => ({
      kind: 'read',
      space: { id: 'space-a', slug: 'team' },
      agents: [declaration()],
    }),
  )

  expect(plan.agentDeclarations?.existingProbeNames).toEqual([])
  expect(plan.questions).not.toContainEqual(expect.objectContaining({ id: 'probe-agents' }))
})

test('space-disabled local agents are offered as one recommended disable action', async () => {
  const plan = emptyPlan()
  const local: LocalAgentDeclaration = { ...declaration(), enabled: true, probedAt: null }
  await addDeclaredAgentsToPlan(plan, [local], [], async () => ({
    kind: 'read',
    space: { id: 'space-a', slug: 'team' },
    agents: [declarationWith({ enabled: false, disabledReason: 'subscription ended' })],
  }))

  expect(plan.questions).toContainEqual(
    expect.objectContaining({
      id: 'apply-space-disabled',
      recommendation: 'apply',
      question: expect.stringContaining('codex-team: subscription ended'),
    }),
  )
  expect(plan.agentDeclarations?.disablements).toEqual([
    { name: 'codex-team', reason: 'subscription ended' },
  ])
})

test('one setup projection includes declared registrations and disablements for harness planning', () => {
  const local = { ...declaration(), enabled: true, probedAt: null }
  const projected = setupAgentsWithDeclarations(
    [{ name: local.name, harness: local.harness, enabled: true, probePassed: false }],
    [local],
    {
      kind: 'read',
      space: { id: 'space-a', slug: 'team' },
      agents: [
        declarationWith({ enabled: false, disabledReason: 'subscription ended' }),
        declarationWith({ name: 'goose-team', harness: 'goose', enabled: true }),
      ],
    },
  )

  expect(projected).toContainEqual(expect.objectContaining({ name: 'codex-team', enabled: false }))
  expect(projected).toContainEqual(
    expect.objectContaining({ name: 'goose-team', harness: 'goose', enabled: true }),
  )
})

test('an unreadable declaration read becomes a non-blocking sign-in notice', async () => {
  const plan = emptyPlan()
  await addDeclaredAgentsToPlan(plan, [], [], async () => ({
    kind: 'unreadable',
    cause: 'signed out',
  }))
  expect(plan.notices).toEqual([
    {
      message: 'space agent declarations could not be read: signed out',
      fix: `${PLATFORM_SLUG} record sign-in`,
      blocking: false,
    },
  ])
})

const preparedMigration = {
  directory: '/backup/state-file',
  manifest: { version: 1, files: [], register: [], secrets: [], settings: [] },
} as PreparedStateFileMigration

test('an answers refusal reverses a state-file move before actions begin', async () => {
  const events: string[] = []
  const service = createSetupService({
    plan: async () => emptyPlan(),
    prepareStateFileMigration: async () => preparedMigration,
    reverseStateFileMigration: async () => {
      events.push('reversed')
      return 'reversed state-file move'
    },
    applyActions: async () => {
      events.push('applied')
      return []
    },
  })

  await expect(service.apply([], null)).rejects.toThrow('reversed state-file move')
  expect(events).toEqual(['reversed'])
})

test('cancelling a prepared interactive setup reverses its state-file move', async () => {
  const events: string[] = []
  const service = createSetupService({
    plan: async () => emptyPlan(),
    prepareStateFileMigration: async () => preparedMigration,
    reverseStateFileMigration: async () => {
      events.push('reversed')
      return 'reversed state-file move'
    },
    applyActions: async () => [],
  })
  const prepared = await service.prepare([])

  await expect(service.cancel(prepared.migration)).resolves.toBe('reversed state-file move')
  expect(events).toEqual(['reversed'])
})

test('an action-boundary refusal reverses the move before setup reports it', async () => {
  const events: string[] = []
  const service = createSetupService({
    plan: async () => emptyPlan(),
    reverseStateFileMigration: async () => {
      events.push('reversed')
      return 'reversed state-file move'
    },
    applyActions: async () => {
      events.push('refused')
      throw new Error('authority changed')
    },
  })

  await expect(service.applyPreparedActions([], preparedMigration)).rejects.toThrow(
    'authority changed; reversed state-file move',
  )
  expect(events).toEqual(['refused', 'reversed'])
})

test('the setup service owns the pending state-file dry run and does not open the plan', async () => {
  let planCalls = 0
  const pending = {
    kind: 'migrate-state-file' as const,
    oldPath: `/state/${LEGACY_ORCHESTRATOR_DATABASE}`,
    newPath: '/state/orchestrator.db',
    status: 'planned' as const,
    message: 'the rest follows the move',
  }
  const service = createSetupService({
    plan: async () => {
      planCalls += 1
      return emptyPlan()
    },
    inspectStateFileMigration: async () => pending,
    applyActions: async () => [],
  })

  await expect(service.dryRun([])).resolves.toEqual({
    stateFileMigration: pending,
    diff: [pending],
  })
  expect(planCalls).toBe(0)
})
