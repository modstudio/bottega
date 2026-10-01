// concern: isolation
/**
 * A throwaway checkout for a worker that writes.
 *
 * Every other job here is read-only, so the worst a bad run could do was waste
 * six minutes. An implementation job edits real files, and the interesting
 * question stops being "was the answer good" and becomes "where did it put its
 * mistakes". A worktree answers it: the worker gets a full checkout on a branch
 * of its own, the architect reads a diff, and a run that went wrong is deleted
 * rather than unpicked.
 *
 * This is the convention the four product projects already use — all carry
 * worktrees under `.claude/worktrees`, one per task and
 * session — and it is what the tools in this niche converged on independently
 * (claude-squad and container-use both isolate per agent, by worktree and by
 * container respectively). Borrowing it costs nothing and keeps a delegated run
 * indistinguishable, on disk, from a parallel session doing the same work.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO ITSELF: commit, push, or merge. The worker's
 * contract governs those operations. Implement and fix workers may commit on
 * their own run branch and leave all changes there for the architect to judge
 * through `orch diff`; a land worker alone may fast-forward trunk from its
 * disposable worktree. No worker pushes.
 */
import { existsSync } from 'node:fs'
import type { MainStackConsumer, WorktreeTool } from '../project/projects.ts'
import { ensureMainStackStarted } from '../resources/main-stack.ts'
import {
  type ClaimRecipePort,
  createWithTool,
  createWorktree,
  createWorktreeForBranch,
  type RecordRecipeResource,
  type RecordWorktree,
} from './worktree-create.ts'
import { createReadOnlyWithTool, createReadOnlyWorktree } from './worktree-readonly.ts'
import type { Worktree } from './worktree-types.ts'

export function worktreeExists(path: string): boolean {
  return existsSync(path)
}

export type CreateWorkerWorktreeOptions = {
  tool: WorktreeTool | null
  cwd: string
  mainProjectPath: string
  runId: number
  writes: boolean
  readOnlyBase: string
  seed?: string
  key?: string
  baseRef?: string
  record: RecordWorktree
  detached: boolean
  existingBranch?: string
  existingBranchTip?: string
  recordRecipeResource?: RecordRecipeResource
  claimRecipePort?: ClaimRecipePort
  templateBaseRef?: string
  mainStackConsumers?: MainStackConsumer[]
}

/** Create the worker tree through the project lifecycle or Git fallback. */
export function createWorkerWorktree(options: CreateWorkerWorktreeOptions): Worktree {
  if (!options.writes) {
    return options.tool?.readonly_create
      ? createReadOnlyWithTool(
          options.tool,
          options.cwd,
          options.runId,
          options.readOnlyBase,
          options.record,
        )
      : createReadOnlyWorktree(
          options.cwd,
          options.runId,
          options.readOnlyBase,
          options.record,
          options.tool?.readonly_provision,
        )
  }
  ensureMainStackStarted({
    projectPath: options.mainProjectPath,
    declaredConsumers: options.mainStackConsumers,
    consumer: 'worktree-create',
  })
  if (options.tool) {
    return createWithTool(
      options.tool,
      options.cwd,
      options.runId,
      options.seed,
      options.key,
      options.existingBranchTip ?? options.baseRef,
      options.record,
      options.detached,
      options.existingBranch,
      options.recordRecipeResource,
      options.claimRecipePort,
      undefined,
      options.templateBaseRef,
    )
  }
  return options.existingBranch
    ? createWorktreeForBranch(options.cwd, options.runId, options.existingBranch, options.record)
    : createWorktree(options.cwd, options.runId, options.baseRef, options.record, options.detached)
}
