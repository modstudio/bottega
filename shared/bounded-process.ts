import { execa } from 'execa'
import { BoundExceededError, CALL_BUDGETS, type CallBudgetName } from './call-budgets.ts'

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

type BoundedSyncOptions = Omit<BoundedProcessOptions, 'signal'>

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

export async function startBounded(
  argv: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedResult> {
  const [file, ...args] = argv
  if (!file) throw new TypeError('startBounded requires a non-empty argv')
  const budget = CALL_BUDGETS[options.budget]
  const result = await execa(file, args, {
    cwd: options.cwd,
    env: options.env,
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
    throw new BoundExceededError(commandText(argv), options.budget, 'deadline', budget.deadlineMs)
  }
  if (result.isMaxBuffer) {
    throw new BoundExceededError(commandText(argv), options.budget, 'output', budget.outputBytes)
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
  const budget = CALL_BUDGETS[options.budget]
  const result = Bun.spawnSync([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: stdinInput(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: budget.deadlineMs,
    maxBuffer: budget.outputBytes,
    killSignal: 'SIGKILL',
    detached: true,
  })
  if (result.exitedDueToTimeout) {
    killProcessGroup(result.pid)
    throw new BoundExceededError(commandText(argv), options.budget, 'deadline', budget.deadlineMs)
  }
  if (
    result.signalCode === 'SIGKILL' &&
    (result.stdout.byteLength >= budget.outputBytes ||
      result.stderr.byteLength >= budget.outputBytes)
  ) {
    killProcessGroup(result.pid)
    throw new BoundExceededError(commandText(argv), options.budget, 'output', budget.outputBytes)
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
