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
 * through `bottega run diff`; a land worker alone may fast-forward trunk from its
 * disposable worktree. No worker pushes.
 */
import { existsSync } from 'node:fs'
import { db } from '../database/db.ts'
import { type HostLoadSample, sampleHostLoad } from '../host-load-sample.ts'
import type { MainStackConsumer, WorktreeTool } from '../project/projects.ts'
import { readSnapshot } from '../recipe/tracked-recipe.ts'
import { ensureMainStackStarted } from '../resources/main-stack.ts'
import { finishProvisioningMeasurement } from './provisioning-measurement.ts'
import {
  type ClaimRecipePort,
  createWithTool,
  createWorktree,
  createWorktreeForBranch,
  type RecordRecipeResource,
  type RecordWorktree,
} from './worktree-create.ts'
import type { ProvisionEntry } from './worktree-provision.ts'
import { createReadOnlyWithTool, createReadOnlyWorktree } from './worktree-readonly.ts'
import type { Worktree } from './worktree-types.ts'

export function worktreeExists(path: string): boolean {
  return existsSync(path)
}

export type CreateWorkerWorktreeOptions = {
  tool: WorktreeTool | null
  cwd: string
  mainProjectPath: string
  runId: string
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
  mainStackRequiredServices?: string[]
  mainStackProject?: { recordId: string; name: string }
  provisionTimeoutMs?: number
}

export function recordProvisioning(
  options: CreateWorkerWorktreeOptions,
  started: number,
  hostLoad: HostLoadSample,
  outcome: 'ok' | 'failed',
  worktree: Worktree | null,
): void {
  const tracked = readSnapshot(options.runId).snapshot
  const provisions: readonly ProvisionEntry[] = options.writes
    ? (tracked?.recipe?.provision ?? [])
    : (options.tool?.readonly_provision ?? [])
  finishProvisioningMeasurement({
    runId: options.runId,
    kind: options.writes ? 'writer' : 'read-only',
    outcome,
    started,
    hostLoad,
    tree: worktree?.path ?? recordedWorktree(options.runId),
    provisions,
  })
}

function recordedWorktree(runId: string): string | null {
  const row = db().query('SELECT worktree FROM run WHERE record_id=?').get(runId) as {
    worktree: string | null
  } | null
  return row?.worktree ?? null
}

function createReadOnlyWorkerWorktree(options: CreateWorkerWorktreeOptions): Worktree {
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
        options.provisionTimeoutMs,
      )
}

function createWritingWorkerWorktree(options: CreateWorkerWorktreeOptions): Worktree {
  if (options.tool)
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
  return options.existingBranch
    ? createWorktreeForBranch(options.cwd, options.runId, options.existingBranch, options.record)
    : createWorktree(options.cwd, options.runId, options.baseRef, options.record, options.detached)
}

/** Create the worker tree through the project lifecycle or Git fallback. */
export function createWorkerWorktree(options: CreateWorkerWorktreeOptions): Worktree {
  const started = performance.now()
  const hostLoad = sampleHostLoad()
  let worktree: Worktree | null = null
  let outcome: 'ok' | 'failed' = 'failed'
  try {
    if (!options.writes) worktree = createReadOnlyWorkerWorktree(options)
    else {
      ensureMainStackStarted({
        projectId: options.mainStackProject?.recordId ?? '',
        projectName: options.mainStackProject?.name ?? options.mainProjectPath,
        projectPath: options.mainProjectPath,
        declaration: options.mainStackConsumers
          ? {
              consumers: options.mainStackConsumers,
              requiredServices: options.mainStackRequiredServices,
            }
          : undefined,
        consumer: 'worktree-create',
      })
      worktree = createWritingWorkerWorktree(options)
    }
    outcome = 'ok'
    return worktree
  } finally {
    recordProvisioning(options, started, hostLoad, outcome, worktree)
  }
}
