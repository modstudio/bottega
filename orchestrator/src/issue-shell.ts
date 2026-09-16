// concern: filed-issue command confinement
/** Pure policy for coordinator-run reproduction and gate commands. */

import { resolve } from 'node:path'
import type { SandboxRuntimeConfig } from './sandbox.ts'

export type FiledIssueCommandPlan = {
  argv: [string, '-lc', string]
  env: Record<string, string>
  profile: SandboxRuntimeConfig
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
  const denied = [...input.secretPaths, input.operatorEnvPath].map((path) => resolve(path))
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
