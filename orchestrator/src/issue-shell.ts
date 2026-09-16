// concern: filed-issue command confinement
/** Pure policy for coordinator-run reproduction and gate commands. */

import { resolve } from 'node:path'
import {
  expandHome,
  READONLY_LENS_DENY_PATHS,
  READONLY_LENS_DENY_SOCKETS,
  type SandboxRuntimeConfig,
} from './sandbox.ts'

export const FILED_ISSUE_COMMAND_TIMEOUT_MS = 20 * 60_000

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
}): { ok: boolean; text: string; exitCode: number } {
  if (spawn.exitedDueToTimeout) {
    return {
      ok: false,
      text: `timed out after ${FILED_ISSUE_COMMAND_TIMEOUT_MS}ms`,
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
