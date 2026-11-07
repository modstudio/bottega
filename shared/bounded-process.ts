import { execa } from 'execa'
import { BoundExceededError, CALL_BUDGETS, type CallBudgetName } from './call-budgets.ts'

export type BoundedResult = { exitCode: number; stdout: string; stderr: string }

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

function stdinBlob(stdin: string | Uint8Array | undefined): Blob | undefined {
  if (stdin === undefined) return undefined
  return new Blob([typeof stdin === 'string' ? stdin : new Uint8Array(stdin)])
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
    input: options.stdin,
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

export function startBoundedSync(
  argv: readonly string[],
  options: BoundedSyncOptions,
): BoundedResult {
  if (argv.length === 0) throw new TypeError('startBoundedSync requires a non-empty argv')
  const budget = CALL_BUDGETS[options.budget]
  const result = Bun.spawnSync({
    cmd: [...argv],
    cwd: options.cwd,
    env: options.env,
    stdin: stdinBlob(options.stdin),
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
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}
