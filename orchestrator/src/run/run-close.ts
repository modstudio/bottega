// concern: run-close
/**
 * Knows post-terminal notifications, failover dispatch, terminal tree reclamation,
 * and result assembly. Must not know run claiming, live execution, terminalisation,
 * run control, dispatch surfaces, or the CLI.
 */
import { existsSync, readFileSync } from 'node:fs'
import { reclaimTerminalTree } from '../close/close-out.ts'
import type { WorkerReply } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import {
  type classify,
  FAILS_OVER,
  NEEDS_HUMAN,
  NEEDS_HUMAN_TITLE,
  notify,
} from '../failure/failure.ts'
import { type Job, reclaimsTreeByDefault } from '../jobs/jobs.ts'
import { mcpRequestFromStored } from '../mcp/mcp-preflight.ts'
import { resolveBranchRef, stackAt } from '../project/projects.ts'
import { CALIBRATION_SUFFIX_RESERVE_BYTES } from '../review/review-calibration.ts'
import {
  decideFailover,
  failoverAttempts,
  failoverRefusalReason,
  failoverSuccessorAgent,
  MAX_FAILOVER_ATTEMPTS,
} from '../route/failover.ts'
import { pick } from '../route/route.ts'
import type { TransportName } from '../transport/transport.ts'
import type { KeepTreeExemption } from '../worktree/keep-tree-hold.ts'
import type { Changes } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { terminateRunProcesses } from './run-process.ts'
import type { RunResult } from './run-types.ts'

type CloseOptions = {
  job: string
  noFailover?: boolean
  avoid?: string[]
  carry?: boolean
}

type SuccessorOptions = {
  job: string
  prompt: string
  agent: string
  transport: TransportName | undefined
  schemaPath: string | undefined
  mcp: ReturnType<typeof mcpRequestFromStored>
  probe: boolean
  label: string | undefined
  lens: string | undefined
  cwd: string
  repo: string | undefined
  retryOf: number
  noFailover: false
  ownerSession: string | null
  automaticFailover: true
  seed: string | undefined
  key: string | undefined
  base: string | undefined
  avoid: string[] | undefined
  carry: boolean | undefined
  review: string | undefined
  deliverables: string[]
  timeoutMinutes: number | undefined
  keepTree: KeepTreeExemption | undefined
  resolvedReviewTarget: { branch: string; commit: string; base: string } | undefined
}

export type CloseInput = {
  failureKind: ReturnType<typeof classify> | null
  name: string
  opts: CloseOptions
  claim: { id: number }
  idleUnkillable: boolean
  status: string
  worktree: Worktree | null
  writesJob: boolean
  changes: Changes | null
  artifactsPersisted: boolean
  idleTreePids: number[]
  idleTreePgid: number | null
  requestedJob: Job
  callerCwd: string
  repoJob: boolean
  declaredDeliverables: string[]
  timeoutMinutes: number | undefined
  keepTree: KeepTreeExemption | undefined
  reason: string
  output: string
  started: number
  exitCode: number
  vendorTokens: number | null
  costUsd: number | null
  outPath: string
  contract: WorkerReply | null
  error: string | null
  run: (opts: SuccessorOptions) => Promise<RunResult>
}

function appendFailoverRefusal(id: number, reason: string): void {
  db()
    .query(`UPDATE run SET error=COALESCE(error || '\n', '') || ? WHERE id=?`)
    .run(`Failover refused: ${reason}`, id)
}

export async function closeRun(input: CloseInput): Promise<RunResult> {
  const {
    failureKind,
    name,
    opts,
    claim,
    idleUnkillable,
    status,
    worktree,
    writesJob,
    changes,
    artifactsPersisted,
    idleTreePids,
    idleTreePgid,
    requestedJob,
    callerCwd,
    repoJob,
    declaredDeliverables,
    timeoutMinutes,
    keepTree,
    reason,
    output,
    started,
    exitCode,
    vendorTokens,
    costUsd,
    outPath,
    contract,
    error,
    run,
  } = input

  // Quota and auth stop this agent working until a person acts. Notify at the
  // moment it happens even though the failover path below can route around it.
  if (failureKind && NEEDS_HUMAN.includes(failureKind)) {
    notify(
      NEEDS_HUMAN_TITLE[failureKind]?.(name) ?? `${name} needs attention`,
      `${opts.job} failed. Routing will avoid it until it succeeds again.`,
    )
  }
  if (idleUnkillable) {
    notify(
      `${name} idle kill did not terminate`,
      `run ${claim.id} still alive after SIGKILL; needs a human`,
    )
  }

  if (status === 'failed' && failureKind && FAILS_OVER.includes(failureKind)) {
    // The vendor is normally gone already. This is deliberately the same PID
    // termination primitive used by `orch stop`, excluding this coordinator:
    // it still has to route and run the successor before it may exit.
    terminateRunProcesses(claim.id, [process.pid])

    const attempts = failoverAttempts(claim.id)
    const tried = attempts.map((attempt) => attempt.agent)
    const first = db()
      .query(
        `SELECT prompt_path, launch_cwd, launch_seed, launch_key, launch_base,
              no_failover, session_id, mcp, mcp_error, schema_path, probe, label, lens, repo,
              base_commit, head_commit, review_ref, transport
         FROM run WHERE id=?`,
      )
      .get(attempts[0]!.id) as {
      prompt_path: string | null
      launch_cwd: string | null
      launch_seed: string | null
      launch_key: string | null
      launch_base: string | null
      no_failover: number
      session_id: string | null
      mcp: number | null
      mcp_error: string | null
      schema_path: string | null
      probe: number
      label: string | null
      lens: string | null
      repo: string | null
      base_commit: string | null
      head_commit: string | null
      review_ref: string | null
      transport: TransportName | null
    }
    const treeName = worktree?.path ?? '(none — read-only job)'
    const failoverFacts = {
      status,
      failureKind,
      failoverKinds: FAILS_OVER,
      noFailover: Boolean(first.no_failover || opts.noFailover),
      writesJob,
      changes,
      worktree: treeName,
      attemptCount: attempts.length,
      maxAttempts: MAX_FAILOVER_ATTEMPTS,
      agentsTried: tried,
      originalPromptAvailable: Boolean(first.prompt_path && existsSync(first.prompt_path)),
    }
    const refusalReason = failoverRefusalReason(decideFailover(failoverFacts))
    if (refusalReason) {
      appendFailoverRefusal(claim.id, refusalReason)
    } else {
      try {
        const originalPrompt = readFileSync(first.prompt_path!, 'utf8')
        const selected = pick(
          opts.job,
          undefined,
          Buffer.byteLength(originalPrompt) +
            (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0),
          true,
          stackAt(first.launch_cwd ?? callerCwd),
          { agents: [...new Set([...(opts.avoid ?? []), ...tried])] },
          false,
          first.lens ?? undefined,
        )
        const successorAgent = failoverSuccessorAgent(
          decideFailover({ ...failoverFacts, successor: selected }),
        )
        console.error(
          `orch: run ${claim.id} failed over after ${name} ${failureKind}; ` +
            `starting the same prompt on ${successorAgent}`,
        )
        // The recursive successor has its own terminalisation path. Reclaim
        // this completed attempt before returning into it, otherwise this
        // frame never reaches the ordinary terminal reclaim below.
        if (artifactsPersisted && worktree && reclaimsTreeByDefault(opts.job)) {
          reclaimTerminalTree(claim.id, worktree, idleTreePids, idleTreePgid)
        }
        return await run({
          job: opts.job,
          prompt: originalPrompt,
          agent: successorAgent,
          transport:
            first.transport === 'cli' || first.transport === 'acp' ? first.transport : undefined,
          schemaPath: first.schema_path ?? undefined,
          mcp: mcpRequestFromStored(first.mcp, first.mcp_error),
          probe: !!first.probe,
          label: first.label ?? undefined,
          lens: first.lens ?? undefined,
          cwd: first.launch_cwd ?? callerCwd,
          repo: first.repo ?? undefined,
          retryOf: claim.id,
          noFailover: false,
          ownerSession: first.session_id,
          automaticFailover: true,
          seed: first.launch_seed ?? undefined,
          key: first.launch_key ?? undefined,
          // Every repository successor must recreate the first attempt's
          // immutable tree before carrying the same caller state. Falling back
          // to current trunk makes a review failover depend on a later move.
          base: repoJob ? (first.base_commit ?? first.launch_base ?? undefined) : undefined,
          avoid: opts.avoid,
          carry: opts.carry,
          review: first.review_ref ?? undefined,
          deliverables: declaredDeliverables,
          timeoutMinutes,
          keepTree,
          resolvedReviewTarget:
            first.review_ref && first.base_commit && first.head_commit
              ? {
                  branch: resolveBranchRef(first.review_ref).branch,
                  commit: first.head_commit,
                  base: first.base_commit,
                }
              : undefined,
        })
      } catch (e) {
        const successor = db().query('SELECT id FROM run WHERE retry_of=?').get(claim.id)
        // Once a successor exists its own terminal row is the explanation.
        if (successor) throw e
        appendFailoverRefusal(
          claim.id,
          failoverRefusalReason(
            decideFailover({
              ...failoverFacts,
              selectionError: String((e as Error)?.message ?? e),
            }),
          )!,
        )
      }
    }
  }

  if (
    artifactsPersisted &&
    worktree &&
    reclaimsTreeByDefault(opts.job) &&
    status !== 'asking' &&
    status !== 'running' &&
    status !== 'stopped'
  ) {
    reclaimTerminalTree(claim.id, worktree, idleTreePids, idleTreePgid)
  }

  if (status === 'failed') {
    throw Object.assign(new Error(`run ${claim.id} failed: ${error}`), { runId: claim.id })
  }
  return {
    id: claim.id,
    agent: name,
    reason,
    output,
    latencyMs: Date.now() - started,
    exitCode,
    vendorTokens,
    costUsd,
    outPath,
    worktree,
    changes,
    contract,
    status,
  }
}
