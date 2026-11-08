// concern: run resource step recording
/** Adapts known run creation effects to the ordered resource-step recorder. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { Agent } from '../agent/agents.ts'
import { writeTransaction } from '../database/db.ts'
import type { McpMode } from '../mcp/mcp-preflight.ts'
import type { Project } from '../project/projects.ts'
import {
  recordCreatedWorktreeClaims,
  recordSandboxDirectoryClaim,
} from '../resources/resource-claims.ts'
import {
  beginResourceStep,
  completeResourceStep,
  insertClaim,
  type ResourceStep,
  recordResourceStep,
  recordResourceStepAsync,
} from '../resources/resource-step-recorder.ts'
import type { RunSandbox } from '../sandbox/sandbox.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import type { workerMcpLaunchScope } from './run-mcp-launch-scope.ts'
import { prepareWorkerHomeLaunch, runScopedHome } from './run-worker-home.ts'

type RunClaimIdentity = {
  rootRunId: string
  runId: string
  projectId: string | null
}

export function readOnlyWorktreeStepRecorder(
  database: Database,
  input: RunClaimIdentity & { writesJob: boolean; claimedAt: () => string },
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
  input: RunClaimIdentity & {
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

export async function prepareSandboxHomeStep<T>(
  database: Database,
  input: RunClaimIdentity & {
    repoJob: boolean
    writesJob: boolean
    harness: string
    sandbox: RunSandbox
    path: string
    claimedAt: string
    effect: () => Promise<T>
  },
): Promise<T> {
  const records = input.repoJob && !input.writesJob && runScopedHome(input.harness, input.sandbox)
  if (!records) return input.effect()
  const claim = {
    ...input,
    kind: 'sandbox_dir' as const,
    allocationKey: input.path,
    identity: input.path,
    label: input.rootRunId,
  }
  if (!existsSync(input.path)) return recordResourceStepAsync(database, claim, input.effect)
  const result = await input.effect()
  const decision = insertClaim(database, claim)
  if (decision === 'collision')
    throw new Error(`sandbox_dir resource ${input.path} is already claimed by another run`)
  return result
}

export function prepareSandboxHomeStepSync<T>(
  database: Database,
  input: RunClaimIdentity & {
    repoJob: boolean
    writesJob: boolean
    harness: string
    sandbox: RunSandbox
    path: string
    claimedAt: string
    effect: () => T
  },
): T {
  const records = input.repoJob && !input.writesJob && runScopedHome(input.harness, input.sandbox)
  if (!records) return input.effect()
  const claim = {
    ...input,
    kind: 'sandbox_dir' as const,
    allocationKey: input.path,
    identity: input.path,
    label: input.rootRunId,
  }
  if (!existsSync(input.path)) return recordResourceStep(database, claim, input.effect)
  const result = input.effect()
  const decision = insertClaim(database, claim)
  if (decision === 'collision')
    throw new Error(`sandbox_dir resource ${input.path} is already claimed by another run`)
  return result
}

export function prepareRecordedWorkerHome(
  database: Database,
  input: RunClaimIdentity & {
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
  return prepareSandboxHomeStep(database, {
    ...input,
    claimedAt: new Date().toISOString(),
    effect,
  })
}

export function recordLegacySandboxHome(
  database: Database,
  input: RunClaimIdentity & { path: string; enabled: boolean },
): void {
  if (!input.enabled) return
  recordSandboxDirectoryClaim(database, {
    ...input,
    path: input.path,
    claimedAt: new Date().toISOString(),
  })
}
