// concern: run resource step recording
/** Adapts known run creation effects to the ordered resource-step recorder. */

import type { Database } from 'bun:sqlite'
import type { Agent } from '../agent/agents.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import type { McpMode } from '../mcp/mcp-preflight.ts'
import type { Project } from '../project/projects.ts'
import {
  recordCreatedWorktreeClaims,
  recordSandboxDirectoryClaim,
  settleClaims,
} from '../resources/resource-claims.ts'
import {
  beginResourceStep,
  type ClaimOwner,
  completeResourceStep,
  recordResourceStep,
  type ResourceStep,
} from '../resources/resource-step-recorder.ts'
import type { RunSandbox } from '../sandbox/sandbox.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import type { workerMcpLaunchScope } from './run-mcp-launch-scope.ts'
import { prepareWorkerHomeLaunch, runScopedHome } from './run-worker-home.ts'

export function readOnlyWorktreeStepRecorder(
  database: Database,
  input: ClaimOwner & { writesJob: boolean; claimedAt: () => string },
): { recordPending: ((planned: Worktree) => void) | undefined; complete: () => boolean } {
  let pending: ResourceStep | null = null
  return {
    recordPending: input.writesJob
      ? undefined
      : (planned) => {
          pending = beginResourceStep(database, {
            ...input,
            kind: 'worktree',
            allocationKey: planned.path,
            identity: JSON.stringify({
              path: planned.path,
              head: planned.base,
              ...(planned.sharedReader ? { sharedReader: true } : {}),
            }),
            label: input.runId,
            claimedAt: input.claimedAt(),
            shared: planned.sharedReader === true,
          })
        },
    complete: () => {
      if (!pending) return false
      completeResourceStep(database, pending)
      return true
    },
  }
}

export function recordRunWorktree(
  database: Database,
  input: ClaimOwner & {
    coverageBase: string | null
    branch: string | null
    steps: { complete: () => boolean }
  },
  created: Worktree,
): void {
  writeTransaction(() => {
    const result = database
      .query(
        `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source=?,
                resource_teardown=CASE WHEN ?='recipe' THEN 'pending' ELSE resource_teardown END
         WHERE record_id=?`,
      )
      .run(
        created.path,
        created.path,
        input.branch,
        created.mintedBranch ?? null,
        input.coverageBase ?? created.base,
        created.source ?? null,
        created.source ?? null,
        input.runId,
      )
    if (result.changes !== 1) throw new Error(`run ${input.runId} could not record its worktree`)
    if (!input.steps.complete())
      recordCreatedWorktreeClaims(database, {
        ...input,
        owned: true,
        path: created.path,
        head: created.base,
        sharedReader: created.sharedReader === true,
        mintedBranch: created.mintedBranch ?? null,
        label: input.runId,
        claimedAt: new Date().toISOString(),
      })
  }, database)
}

export function recordRunLeaseStep<T extends { release(): void }>(
  database: Database,
  input: ClaimOwner & {
    repoJob: boolean
    writesJob: boolean
    path: string
    effect: () => T
  },
): T {
  if (!input.repoJob || input.writesJob) return input.effect()
  const lease = recordResourceStep(database, {
    ...input,
    kind: 'run_lease',
    allocationKey: input.path,
    identity: input.path,
    label: input.runId,
    claimedAt: nowIso(),
  }, input.effect)
  return {
    ...lease,
    release: () => {
      try {
        lease.release()
      } finally {
        settleClaims(database, {
          rootRunId: input.rootRunId,
          kind: 'run_lease',
          state: 'released',
          settledAt: nowIso(),
          detail: 'run lease released',
          allocationKey: input.path,
        })
      }
    },
  }
}

function sandboxHomeClaimMode(input: {
  repoJob: boolean
  writesJob: boolean
  harness: string
  sandbox: RunSandbox
}): 'step' | 'legacy' | 'none' {
  if (!runScopedHome(input.harness, input.sandbox)) return 'none'
  return input.repoJob && !input.writesJob ? 'step' : 'legacy'
}

type SandboxHomeStepInput<T> = ClaimOwner & {
  repoJob: boolean
  writesJob: boolean
  harness: string
  sandbox: RunSandbox
  path: string
  claimedAt: string
  effect: () => T
}

export function claimSandboxHomeStep<T>(
  database: Database,
  input: SandboxHomeStepInput<T>,
): T {
  if (sandboxHomeClaimMode(input) !== 'step') return input.effect()
  const claim = {
    ...input,
    kind: 'sandbox_dir' as const,
    allocationKey: input.path,
    identity: input.path,
    label: input.rootRunId,
  }
  const step = beginResourceStep(database, claim)
  const result = input.effect()
  if (result instanceof Promise) {
    return result.then((resolved) => {
      completeResourceStep(database, step)
      return resolved
    }) as T
  }
  completeResourceStep(database, step)
  return result
}

export function prepareRecordedWorkerHome(
  database: Database,
  input: ClaimOwner & {
    agent: Agent
    harness: string
    sandbox: RunSandbox
    path: string
    runNumber: number
    runToken: string
    environment: Record<string, string>
    grokEnvironment: Record<string, string>
    repoJob: boolean
    writesJob: boolean
    mcpLaunch: ReturnType<typeof workerMcpLaunchScope>
    mcpMode: McpMode | null
    project: Project | null
  },
) {
  const effect = () =>
    prepareWorkerHomeLaunch({
      agent: input.agent,
      sandbox: input.sandbox,
      runDir: input.path,
      runNumber: input.runNumber,
      runRecordId: input.runId,
      runToken: input.runToken,
      environment: input.environment,
      grokEnvironment: input.grokEnvironment,
      includeStore: input.repoJob,
      mcpLaunch: input.mcpLaunch,
      mcpMode: input.mcpMode,
      project: input.project,
    })
  return claimSandboxHomeStep(database, {
    ...input,
    claimedAt: new Date().toISOString(),
    effect,
  })
}

export function recordLegacySandboxHome(
  database: Database,
  input: ClaimOwner & {
    path: string
    repoJob: boolean
    writesJob: boolean
    harness: string
    sandbox: RunSandbox
  },
): void {
  if (sandboxHomeClaimMode(input) !== 'legacy') return
  recordSandboxDirectoryClaim(database, {
    ...input,
    path: input.path,
    claimedAt: new Date().toISOString(),
  })
}
