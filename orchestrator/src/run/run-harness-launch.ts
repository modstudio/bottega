// concern: harness run launch
/** Supplies the reserved harness marker and the synchronous post-claim handoff. */

import { readDelegationSettings } from '../../../shared/machine-config.ts'
import type { Agent } from '../agent/agents.ts'
import { isHarnessDelegated } from '../jobs/delegation.ts'
import { effectiveMcpRequest, type McpRequest } from '../mcp/mcp-preflight.ts'
import * as acpWriter from './run-acp-writer.ts'
import type { ClaimResult } from './run-claim-types.ts'
import { prepareHarnessConfinement } from './run-confinement.ts'
import { HARNESS_AGENT } from './run-executor.ts'
import { bindSignals } from './run-process.ts'
import type { RunResult } from './run-types.ts'
import {
  recordSharedGitConfigSnapshotFailure,
  snapshotWritingRunSharedGitConfig,
} from './shared-git-config.ts'

export function harnessAgent(): Agent {
  return {
    name: HARNESS_AGENT,
    bin: '',
    minimumCliVersion: '0.0.0',
    billing: 'subscription',
    operatedBy: 'vendor',
    model: 'harness',
    caps: {
      readsRepo: true,
      writesRepo: true,
      mcp: false,
      discoversMcpFromCwd: false,
      schema: true,
      replyFile: true,
      resumable: true,
    },
    defaultTransport: 'cli',
    argv: () => [],
    stdin: false,
    maxPromptBytes: Number.POSITIVE_INFINITY,
    readsOut: false,
    timeoutMs: Number.POSITIVE_INFINITY,
    contextTokens: Number.POSITIVE_INFINITY,
    outputCeilingStopReason: null,
    notes: 'The caller harness executes this run in-session.',
  }
}

export function harnessDispatch(
  needs: Parameters<typeof isHarnessDelegated>[0] & { mcp?: boolean },
  request?: McpRequest,
) {
  const harness = isHarnessDelegated(needs, readDelegationSettings())
  return { harness, mcpRequest: harness ? undefined : effectiveMcpRequest(request, { needs }) }
}

export function completeRunStartup(): true {
  bindSignals()
  return true
}

function harnessRunningResult(
  input: ClaimResult,
  reason: string,
  writesJob: boolean,
): RunResult {
  const roots = acpWriter.runRoots(
    input.worktree,
    writesJob,
    false,
    input.scratchDir,
    input.runtimeDir,
  )
  recordSharedGitConfigSnapshotFailure(
    input.claim.id,
    snapshotWritingRunSharedGitConfig({
      runId: input.claim.id,
      writesJob,
      worktree: input.worktree?.path ?? null,
      writableRoots: roots,
    }),
  )
  return {
    record_id: input.claim.id,
    number: input.claim.number,
    agent: HARNESS_AGENT,
    reason,
    output: '',
    latencyMs: 0,
    exitCode: 0,
    vendorTokens: null,
    costUsd: null,
    outPath: input.outputPath,
    worktree: input.worktree,
    changes: input.changes,
    contract: null,
    status: 'running',
  }
}

export function runningResult(
  input: ClaimResult,
  reason: string,
  writesJob: boolean,
  callerCwd: string,
  runProjectName: string | null,
): RunResult {
  prepareHarnessConfinement({
    agent: HARNESS_AGENT,
    cwd: input.cwd,
    worktree: input.worktree,
    writesRepo: writesJob,
    scratchDir: input.scratchDir,
    runtimeDir: input.runtimeDir,
    callerCwd,
    isolatedCwd: input.isolatedCwd,
    runProjectName,
  })
  return harnessRunningResult(input, reason, writesJob)
}
