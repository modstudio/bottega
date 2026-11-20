import { closeSync, openSync } from 'node:fs'
import { execa } from 'execa'
import {
  BoundExceededError,
  budgetForArgv,
  CALL_BUDGETS,
  type CallBudgetName,
} from './call-budgets.ts'

/**
 * A breached bound throws BoundExceededError naming its budget and remedy. A wrapper whose
 * documented contract is never to fail its caller may catch it and return that contract's
 * no-answer; every other wrapper lets it escape.
 */

export type BoundedResult = { exitCode: number; stdout: string; stderr: string }
export type BoundedBytesResult = { exitCode: number; stdout: Uint8Array; stderr: string }

type BoundedProcessOptions = {
  budget: CallBudgetName
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: string | Uint8Array
  signal?: AbortSignal
}

type BoundedSyncOptions = Omit<BoundedProcessOptions, 'signal'> & { stdinFile?: string }

type ParentBoundProcessOptions = {
  name: string
  cwd?: string
  env?: Record<string, string | undefined>
  exitOnSignal?: boolean
  inheritStdio?: boolean
}

type ParentBoundChild = {
  exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
  exitOnSignal: boolean
}

type ParentBoundStartedChild = Bun.Subprocess
type ParentBoundPipedChild = Bun.PipedSubprocess

const parentBoundChildren = new Set<ParentBoundChild>()
let parentBoundHooksInstalled = false

function killParentBoundChildren(signal: NodeJS.Signals): void {
  for (const child of parentBoundChildren) child.kill(signal)
}

/**
 * The parent always relays the signal to tracked children. It exits immediately by default, but
 * waits for the child to finish when every tracked child opts out.
 */
export function parentBoundSignalExitCode(
  signal: 'SIGINT' | 'SIGTERM',
  childExitFlags: readonly boolean[],
): number | null {
  if (childExitFlags.length > 0 && childExitFlags.every((exitOnSignal) => !exitOnSignal))
    return null
  return signal === 'SIGINT' ? 130 : 143
}

function handleParentBoundSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  const children = [...parentBoundChildren]
  killParentBoundChildren(signal)
  const exitCode = parentBoundSignalExitCode(
    signal,
    children.map((child) => child.exitOnSignal),
  )
  if (exitCode !== null) process.exit(exitCode)
}

function installParentBoundHooks(): void {
  if (parentBoundHooksInstalled) return
  parentBoundHooksInstalled = true
  process.once('exit', () => killParentBoundChildren('SIGTERM'))
  process.once('SIGINT', () => handleParentBoundSignal('SIGINT'))
  process.once('SIGTERM', () => handleParentBoundSignal('SIGTERM'))
}

/** Start a streaming child whose lifetime is bounded by this parent instead of a deadline. */
export function startParentBound(
  argv: readonly string[],
  options: ParentBoundProcessOptions & { inheritStdio: true },
): ParentBoundStartedChild
export function startParentBound(
  argv: readonly string[],
  options: ParentBoundProcessOptions & { inheritStdio?: false },
): ParentBoundPipedChild
export function startParentBound(
  argv: readonly string[],
  options: ParentBoundProcessOptions,
): ParentBoundStartedChild {
  if (!argv.length) throw new TypeError(`${options.name} requires a non-empty argv`)
  installParentBoundHooks()
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.inheritStdio ? 'inherit' : 'pipe',
    stdout: options.inheritStdio ? 'inherit' : 'pipe',
    stderr: options.inheritStdio ? 'inherit' : 'pipe',
  })
  const tracked = Object.assign(child, { exitOnSignal: options.exitOnSignal !== false })
  parentBoundChildren.add(tracked)
  void child.exited.then(() => parentBoundChildren.delete(tracked))
  return child as ParentBoundStartedChild
}

export function isDeadlineAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

/** Identify the deadline failure emitted by a named bounded process. */
export function isDeadlineBreach(error: unknown): boolean {
  return error instanceof BoundExceededError && error.bound === 'deadline'
}

/** Read a named process deadline without exposing the mutable budget table to callers. */
export function boundedDeadlineMs(budget: CallBudgetName): number {
  return CALL_BUDGETS[budget].deadlineMs
}

function commandText(argv: readonly string[]): string {
  return argv.join(' ')
}

function exitCode(code: number | null | undefined): number {
  return code ?? 1
}

function stdinInput(stdin: string | Uint8Array | undefined): Blob | Uint8Array | undefined {
  if (stdin === undefined) return undefined
  return typeof stdin === 'string' ? new Blob([stdin]) : stdin
}

/** Resolve the named budget that a bounded argv must receive. */
function effectiveBudgetForArgv(
  argv: readonly string[],
  callerBudget: CallBudgetName,
): CallBudgetName {
  if (argv[0] !== 'git') return callerBudget
  if (callerBudget !== 'git-plumbing' && callerBudget !== 'git-network') return callerBudget
  const classifiedBudget = budgetForArgv(argv)
  return CALL_BUDGETS[classifiedBudget].deadlineMs > CALL_BUDGETS[callerBudget].deadlineMs
    ? classifiedBudget
    : callerBudget
}

export async function startBounded(
  argv: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedResult> {
  const [file, ...args] = argv
  if (!file) throw new TypeError('startBounded requires a non-empty argv')
  const budgetName = effectiveBudgetForArgv(argv, options.budget)
  const budget = CALL_BUDGETS[budgetName]
  const result = await execa(file, args, {
    cwd: options.cwd,
    env: options.env,
    ...(options.env === undefined ? {} : { extendEnv: false }),
    ...(options.stdin === undefined ? { stdin: 'ignore' as const } : { input: options.stdin }),
    cancelSignal: options.signal,
    timeout: budget.deadlineMs,
    forceKillAfterDelay: budget.graceMs,
    killDescendants: true,
    maxBuffer: budget.outputBytes,
    reject: false,
  })
  if (result.isCanceled) options.signal?.throwIfAborted()
  if (result.timedOut) {
    throw new BoundExceededError(commandText(argv), budgetName, 'deadline', budget.deadlineMs)
  }
  if (result.isMaxBuffer) {
    throw new BoundExceededError(commandText(argv), budgetName, 'output', budget.outputBytes)
  }
  return { exitCode: exitCode(result.exitCode), stdout: result.stdout, stderr: result.stderr }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'ESRCH') throw error
  }
}

export function startBoundedSyncBytes(
  argv: readonly string[],
  options: BoundedSyncOptions,
): BoundedBytesResult {
  if (argv.length === 0) throw new TypeError('startBoundedSync requires a non-empty argv')
  const budgetName = effectiveBudgetForArgv(argv, options.budget)
  const budget = CALL_BUDGETS[budgetName]
  if (options.stdin !== undefined && options.stdinFile !== undefined) {
    throw new TypeError('startBoundedSync accepts either stdin or stdinFile, not both')
  }
  const stdinFd = options.stdinFile === undefined ? undefined : openSync(options.stdinFile, 'r')
  const result = (() => {
    try {
      return Bun.spawnSync([...argv], {
        cwd: options.cwd,
        env: options.env,
        stdin: stdinFd ?? stdinInput(options.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: budget.deadlineMs,
        maxBuffer: budget.outputBytes,
        killSignal: 'SIGKILL',
        detached: true,
      })
    } finally {
      if (stdinFd !== undefined) closeSync(stdinFd)
    }
  })()
  if (result.exitedDueToTimeout) {
    killProcessGroup(result.pid)
    throw new BoundExceededError(commandText(argv), budgetName, 'deadline', budget.deadlineMs)
  }
  if (
    result.signalCode === 'SIGKILL' &&
    (result.stdout.byteLength >= budget.outputBytes ||
      result.stderr.byteLength >= budget.outputBytes)
  ) {
    killProcessGroup(result.pid)
    throw new BoundExceededError(commandText(argv), budgetName, 'output', budget.outputBytes)
  }
  return {
    exitCode: exitCode(result.exitCode),
    stdout: result.stdout,
    stderr: result.stderr.toString(),
  }
}

export function startBoundedSync(
  argv: readonly string[],
  options: BoundedSyncOptions,
): BoundedResult {
  const result = startBoundedSyncBytes(argv, options)
  // ignoreBOM keeps a leading byte-order mark, as Buffer.toString did before the migration.
  return { ...result, stdout: new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.stdout) }
}
