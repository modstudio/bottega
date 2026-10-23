import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_ORCHESTRATOR_DATABASE } from '../../../shared/state-directory.ts'
import type { SetupPlan } from './setup-engine.ts'
import type { PreparedStateFileMigration } from './setup-environment.ts'
import { LEGACY_MCP_TOOL_PREFIX } from './setup-mcp-config.ts'
import { addMcpConfigMigrations, createSetupService } from './setup-service.ts'

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
  questions: [],
  notices: [],
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
