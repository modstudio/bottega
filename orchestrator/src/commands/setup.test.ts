import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { FROZEN_STATE_NAMES, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { LEGACY_ORCHESTRATOR_DATABASE } from '../../../shared/state-directory.ts'
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

test('setup plan reports a legacy state-file move without creating the destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-plan-state-file-'))
  const directory = join(root, 'orchestrator')
  const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
  const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
  mkdirSync(directory, { recursive: true })
  writeFileSync(legacy, 'legacy')
  process.env.BOTTEGA_STATE_HOME = root
  delete process.env.BOTTEGA_ORCHESTRATOR_DB
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
    register(program)
    await program.parseAsync(['node', PLATFORM_SLUG, 'setup', 'plan', '--json'])
    await drainStdout()
    expect(output.join('')).toContain('the rest of the setup plan follows this move')
    expect(existsSync(current)).toBeFalse()
  } finally {
    process.stdout.write = originalWrite
    rmSync(root, { recursive: true, force: true })
  }
})

test('setup apply reaches its state-file action without creating the destination first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-apply-state-file-'))
  const directory = join(root, 'orchestrator')
  const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
  const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
  mkdirSync(directory, { recursive: true })
  writeFileSync(legacy, 'legacy')
  process.env.BOTTEGA_STATE_HOME = root
  delete process.env.BOTTEGA_ORCHESTRATOR_DB
  try {
    const program = new Command().exitOverride()
    register(program)
    const refusal = await program
      .parseAsync(['node', PLATFORM_SLUG, 'setup', 'apply', '--yes', '--json'])
      .then(
        () => null,
        (error: unknown) => String(error),
      )
    // A linked-worktree binary refuses before the move; a main-checkout binary performs it.
    // Either way the destination is never created empty ahead of the state-file action.
    if (refusal === null) {
      expect(readFileSync(current, 'utf8')).toBe('legacy')
      expect(existsSync(legacy)).toBeFalse()
    } else {
      expect(refusal).toContain('refusing to migrate the store from a linked-worktree binary')
      expect(existsSync(current)).toBeFalse()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('setup restore refuses a worker-marked caller before reading the backup', async () => {
  process.env.BOTTEGA_RUN_ID = 'setup-restore-worker'
  const program = new Command().exitOverride()
  register(program)

  await expect(
    program.parseAsync(['node', PLATFORM_SLUG, 'setup', 'restore', '/does/not/exist']),
  ).rejects.toThrow('refusing setup restore from an orchestrator worker run')
})
