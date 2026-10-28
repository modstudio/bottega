import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { FROZEN_STATE_NAMES, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { LEGACY_ORCHESTRATOR_DATABASE } from '../../../shared/state-directory.ts'
import type { SetupPlan } from '../setup/setup-engine.ts'
import type { SetupService } from '../setup/setup-service.ts'
import { register } from './setup.ts'
import { drainStdout } from './support.ts'

const priorRunId = process.env.BOTTEGA_RUN_ID
const priorStateHome = process.env.BOTTEGA_STATE_HOME
const priorDatabase = process.env.BOTTEGA_ORCHESTRATOR_DB
const priorExitCode = process.exitCode

afterEach(() => {
  // Bun keeps a set exit code when it is assigned undefined, so an unset prior restores as 0.
  process.exitCode = priorExitCode ?? 0
  if (priorRunId === undefined) delete process.env.BOTTEGA_RUN_ID
  else process.env.BOTTEGA_RUN_ID = priorRunId
  if (priorStateHome === undefined) delete process.env.BOTTEGA_STATE_HOME
  else process.env.BOTTEGA_STATE_HOME = priorStateHome
  if (priorDatabase === undefined) delete process.env.BOTTEGA_ORCHESTRATOR_DB
  else process.env.BOTTEGA_ORCHESTRATOR_DB = priorDatabase
})

function stubSetupService(overrides: Partial<SetupService>): SetupService {
  const plan: SetupPlan = {
    facts: { machine: {} as SetupPlan['facts']['machine'], repositories: [] },
    proposals: [],
    registrations: [],
    questions: [],
    notices: [],
  }
  const outcome = { plan, actions: [], results: [] }
  return {
    plan: async () => plan,
    dryRun: async () => ({ ...plan, diff: [] }),
    prepare: async () => ({ plan, migration: null }),
    cancel: async () => null,
    applyPreparedActions: async () => [],
    apply: async () => outcome,
    applyRecommended: async () => outcome,
    ...overrides,
  }
}

describe('setup plan state-file action', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'setup-plan-state-file-'))
    process.env.BOTTEGA_STATE_HOME = root
    delete process.env.BOTTEGA_ORCHESTRATOR_DB
  })

  test('setup plan reports a legacy state-file move without creating the destination', async () => {
    const directory = join(root, 'orchestrator')
    const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
    const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
    mkdirSync(directory, { recursive: true })
    writeFileSync(legacy, 'legacy')
    const stateFileMigration = {
      kind: 'migrate-state-file' as const,
      oldPath: legacy,
      newPath: current,
      status: 'planned' as const,
      message:
        'Move the orchestrator state file first; the rest of the setup plan follows this move.',
    }
    const service = stubSetupService({
      dryRun: async () => ({ stateFileMigration, diff: [stateFileMigration] }),
    })
    const output: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = ((value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      output.push(String(value))
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      if (typeof done === 'function') done()
      return true
    }) as typeof process.stdout.write
    try {
      const program = new Command().exitOverride()
      register(program, service)
      await program.parseAsync(['node', PLATFORM_SLUG, 'setup', 'plan', '--json'])
      await drainStdout()
      expect(output.join('')).toContain('the rest of the setup plan follows this move')
      expect(existsSync(current)).toBeFalse()
    } finally {
      process.stdout.write = originalWrite
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('setup apply state-file action', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'setup-apply-state-file-'))
    process.env.BOTTEGA_STATE_HOME = root
    delete process.env.BOTTEGA_ORCHESTRATOR_DB
  })

  test('setup apply reaches its state-file action without creating the destination first', async () => {
    const directory = join(root, 'orchestrator')
    const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
    const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
    mkdirSync(directory, { recursive: true })
    writeFileSync(legacy, 'legacy')
    let serviceCalled = false
    let destinationExistedWhenCalled: boolean | null = null
    const service = stubSetupService({
      applyRecommended: async () => {
        serviceCalled = true
        destinationExistedWhenCalled = existsSync(current)
        return { plan: await service.plan([]), actions: [], results: [] }
      },
    })

    try {
      const program = new Command().exitOverride()
      register(program, service)
      await program.parseAsync(['node', PLATFORM_SLUG, 'setup', 'apply', '--yes', '--json'])
      expect(serviceCalled).toBeTrue()
      expect(destinationExistedWhenCalled).toBeFalse()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('setup restore refuses a worker-marked caller before reading the backup', async () => {
  process.env.BOTTEGA_RUN_ID = 'setup-restore-worker'
  const program = new Command().exitOverride()
  register(program)

  await expect(
    program.parseAsync(['node', PLATFORM_SLUG, 'setup', 'restore', '/does/not/exist']),
  ).rejects.toThrow('refusing setup restore from an orchestrator worker run')
})
