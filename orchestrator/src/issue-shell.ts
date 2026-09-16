// concern: filed-issue command confinement
/** Policy and execution for coordinator-run reproduction and gate commands. */

import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { isGroupKillablePgid, sampleProcesses, terminateProcessGroup } from './idle-kill.ts'
import {
  expandHome,
  READONLY_LENS_DENY_PATHS,
  READONLY_LENS_DENY_SOCKETS,
  type SandboxRuntimeConfig,
} from './sandbox.ts'

export const FILED_ISSUE_COMMAND_TIMEOUT_MS = 20 * 60_000
const FILED_ISSUE_COMMAND_KILL_SIGNAL = 'SIGKILL'

const WORKER_GATE_ENV_EXACT = new Set([
  'PATH',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'ORCH_GUARDED_GIT_COMMON_DIR',
  'ORCH_ALLOWED_GIT_REF',
])

export type FiledIssueCommandPlan = {
  argv: [string, '-lc', string]
  env: Record<string, string>
  profile: SandboxRuntimeConfig
}

/** Non-secret host env the worker-environment gate may inherit. */
export function workerGateEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!value) continue
    if (WORKER_GATE_ENV_EXACT.has(key) || key.startsWith('LC_')) env[key] = value
  }
  return env
}

export function issueRunAsked(
  run: { status: string },
  reply: { status: string; questions?: unknown[] | null },
): boolean {
  return run.status === 'asking' || reply.status !== 'done' || Boolean(reply.questions?.length)
}

export function issueFixReady(
  fix: {
    status: string
    outcome: string | null
    cause_location: string | null
    after: string | null
  },
  diagnosis: { cause_location: string | null; before: string | null },
  before: string,
  after: string,
  plainGateOk: boolean,
  environmentGateOk: boolean,
  findings: number,
): boolean {
  return (
    fix.status === 'done' &&
    fix.outcome === 'fixed' &&
    fix.cause_location === diagnosis.cause_location &&
    before === diagnosis.before &&
    after === fix.after &&
    before !== after &&
    plainGateOk &&
    environmentGateOk &&
    findings === 0
  )
}

export function filedIssueCommandResult(spawn: {
  exitCode: number | null
  stdout: { toString(): string }
  stderr: { toString(): string }
  exitedDueToTimeout?: boolean
  groupRemains?: boolean
}): { ok: boolean; text: string; exitCode: number } {
  if (spawn.exitedDueToTimeout) {
    const limit = `timed out after ${FILED_ISSUE_COMMAND_TIMEOUT_MS}ms`
    return {
      ok: false,
      text: spawn.groupRemains ? `${limit}; process group still has members` : limit,
      exitCode: spawn.exitCode ?? -1,
    }
  }
  const text = `${spawn.stdout.toString()}${spawn.stderr.toString()}`.trim()
  return {
    ok: spawn.exitCode === 0,
    text: text || `exit ${spawn.exitCode}`,
    exitCode: spawn.exitCode ?? -1,
  }
}

function waitForFiledIssueCommand(
  child: ChildProcess,
  timeoutMs: number,
): Promise<'exit' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (outcome: 'exit' | 'timeout') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    child.once('close', () => finish('exit'))
    child.once('error', () => finish('exit'))
  })
}

async function killFiledIssueCommandGroup(pid: number): Promise<boolean> {
  const samples = sampleProcesses()
  const pgid = samples.find((row) => row.pid === pid)?.pgid ?? null
  const selfPgid = samples.find((row) => row.pid === process.pid)?.pgid ?? null
  if (isGroupKillablePgid(pgid, selfPgid) && pgid != null) {
    try {
      process.kill(-pgid, FILED_ISSUE_COMMAND_KILL_SIGNAL)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH' && code !== 'EPERM') throw error
    }
  }
  const killed = await terminateProcessGroup(pid, { graceMs: 0 })
  return !killed.exited
}

/** Run a confined command in its own process group and SIGKILL that group on timeout. */
export async function runFiledIssueCommand(
  launch: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ ok: boolean; text: string; exitCode: number }> {
  const child = spawn(launch[0]!, launch.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const pid = child.pid ?? 0
  const outcome = await waitForFiledIssueCommand(child, FILED_ISSUE_COMMAND_TIMEOUT_MS)
  if (outcome !== 'timeout') {
    return filedIssueCommandResult({ exitCode: child.exitCode, stdout, stderr })
  }
  const groupRemains = pid > 1 ? await killFiledIssueCommandGroup(pid) : true
  return filedIssueCommandResult({
    exitCode: child.exitCode ?? -1,
    stdout,
    stderr,
    exitedDueToTimeout: true,
    groupRemains,
  })
}

export function filedIssueCommandPlan(input: {
  command: string
  worktree: string
  sandboxHome: string
  path: string
  lang: string
  operatorEnvPath: string
  secretPaths: readonly string[]
  workerEnvironment?: Readonly<Record<string, string>>
}): FiledIssueCommandPlan {
  const worktree = resolve(input.worktree)
  const sandboxHome = resolve(input.sandboxHome)
  const denied = [
    ...READONLY_LENS_DENY_PATHS.map(expandHome).map((path) => resolve(path)),
    ...READONLY_LENS_DENY_SOCKETS,
    ...input.secretPaths,
    input.operatorEnvPath,
  ].map((path) => resolve(path))
  return {
    argv: ['sh', '-lc', input.command],
    env: {
      ...(input.workerEnvironment ?? {}),
      PATH: input.path,
      HOME: sandboxHome,
      LANG: input.lang,
      TMPDIR: sandboxHome,
    },
    profile: {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [],
        allowLocalBinding: true,
      },
      filesystem: {
        denyRead: [...new Set(denied)],
        allowWithinDeny: [],
        allowWrite: [worktree, sandboxHome],
        denyWrite: [],
      },
    },
  }
}
