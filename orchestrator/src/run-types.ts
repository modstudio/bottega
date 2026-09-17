// concern: run-types
/** Shared run result types. Contains no runtime behavior or dependencies. */
import type { WorkerReply } from './contract/contract.ts'
import type { Changes } from './worktree/worktree-remove.ts'
import type { Worktree } from './worktree/worktree-types.ts'

export type RunResult = {
  id: number
  agent: string
  reason: string
  output: string
  latencyMs: number
  exitCode: number
  vendorTokens: number | null
  /** Only grok reports what a call cost; null everywhere else. */
  costUsd: number | null
  outPath: string
  /** Where a repository worker ran, and what it changed. Null for a non-repository job. */
  worktree: Worktree | null
  changes: Changes | null
  /** The worker's structured reply, when the job carried a contract. */
  contract: WorkerReply | null
  /** Terminal state, so a caller can tell `asking` from `ok` without re-reading the row. */
  status: string
}
