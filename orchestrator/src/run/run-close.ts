// concern: run-close
/**
 * Knows post-terminal notifications, failover dispatch, terminal tree reclamation,
 * and result assembly. Must not know run claiming, live execution, terminalisation,
 * run control, dispatch surfaces, or the CLI.
 */
import { existsSync, readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { reclaimTerminalTree } from '../close/close-out.ts'
import type { WorkerReply } from '../contract/contract.ts'
import { db, writeTransaction } from '../database/db.ts'
import {
  billingHoldForFailure,
  type classify,
  type EffectiveBillingKey,
  FAILOVER_REFUSAL_MARKER,
  FAILS_OVER,
  NEEDS_HUMAN,
  NEEDS_HUMAN_TITLE,
  notify,
} from '../failure/failure.ts'
import { reclaimsTreeByDefault } from '../jobs/jobs.ts'
import { mcpRequestFromStored, requiredMcpServer } from '../mcp/mcp-preflight.ts'
import { resolveBranchRef, stackAt } from '../project/projects.ts'
import type { ReviewRole } from '../review/review-role.ts'
import {
  decideFailover,
  failoverAttemptLimit,
  failoverAttempts,
  failoverRefusalReason,
  failoverSuccessorAgent,
} from '../route/failover.ts'
import { agentsIneligibleForTransport, pick } from '../route/route.ts'
import { AgentCapacityError } from '../route/routing-refusal.ts'
import type { TransportName } from '../transport/transport.ts'
import type { KeepTreeExemption } from '../worktree/keep-tree-hold.ts'
import type { Changes } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_CHAIN_TERMINAL } from './question-close.ts'
import { selectAgentWithCapacityEvents } from './run-agent-capacity.ts'
import { terminateRunProcesses } from './run-process.ts'
import type { RunResult } from './run-types.ts'

type CloseOptions = {
  job: string
  noFailover?: boolean
  avoid?: string[]
  distinctModels?: string[]
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
  reviewRole: ReviewRole | undefined
  cwd: string
  repo: string | undefined
  retryOf: string
  noFailover: false
  ownerSession: string | null
  automaticFailover: true
  seed: string | undefined
  key: string | undefined
  base: string | undefined
  avoid: string[] | undefined
  distinctModels: string[] | undefined
  carry: boolean | undefined
  review: string | undefined
  deliverables: string[]
  timeoutMinutes: number | undefined
  keepTree: KeepTreeExemption | undefined
  resolvedReviewTarget: { branch: string; commit: string; base: string } | undefined
}

export type CloseInput = {
  failureKind: ReturnType<typeof classify> | null
  billingHoldDetail?: string
  endpointKey: EffectiveBillingKey
  name: string
  opts: CloseOptions
  /** The prompt size this run's pick ranked on, for a failover successor to reuse. */
  pickBytes: number
  claim: { id: string; number: number }
  idleUnkillable: boolean
  status: string
  worktree: Worktree | null
  writesJob: boolean
  changes: Changes | null
  artifactsPersisted: boolean
  idleTreePids: number[]
  idleTreePgid: number | null
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

function failoverRefusalMessage(id: string, reason: string, retryCommand: boolean): string {
  const remedy = retryCommand ? `; retry with ${PLATFORM_SLUG} run retry ${id} --agent <name>` : ''
  return `${FAILOVER_REFUSAL_MARKER} ${reason}${remedy}`
}

function appendFailoverRefusal(id: string, reason: string, retryCommand = false): void {
  db()
    .query(`UPDATE run SET error=COALESCE(error || '\n', '') || ? WHERE record_id=?`)
    .run(failoverRefusalMessage(id, reason, retryCommand), id)
}

function hasFailoverSuccessor(id: string): boolean {
  return Boolean(db().query('SELECT record_id FROM run WHERE retry_of_record_id=?').get(id))
}

export function failoverSelectionConstraints(input: {
  transport: TransportName | null
  transportExplicit: number
  avoided: string[] | undefined
  distinctModels: string[] | undefined
  tried: string[]
  transportExcluded: string[]
}): {
  pinnedTransport: TransportName | null
  successorTransport: TransportName | undefined
  avoidedAgents: string[]
  distinctModels: string[] | undefined
} {
  const pinnedTransport = input.transportExplicit ? input.transport : null
  return {
    pinnedTransport,
    successorTransport: pinnedTransport ?? undefined,
    distinctModels: input.distinctModels,
    avoidedAgents: [
      ...new Set([
        ...(input.avoided ?? []),
        ...input.tried,
        ...(pinnedTransport ? input.transportExcluded : []),
      ]),
    ],
  }
}

function storedFailoverSelectionConstraints(
  first: { transport: TransportName | null; transport_explicit: number },
  opts: Pick<CloseOptions, 'job' | 'avoid' | 'distinctModels'>,
  tried: string[],
) {
  return failoverSelectionConstraints({
    transport: first.transport,
    transportExplicit: first.transport_explicit,
    avoided: opts.avoid,
    distinctModels: opts.distinctModels,
    tried,
    transportExcluded: first.transport
      ? agentsIneligibleForTransport(opts.job, first.transport)
      : [],
  })
}

export async function selectFailoverSuccessor(input: {
  runId: string
  job: string
  /**
   * The prompt size the pick that chose this agent measured. A failover ranks
   * the successor on the same bytes, so it lands in the same prompt-size bucket
   * and against the same per-agent limit as the original route.
   */
  pickBytes: number
  lens: string | null
  launchCwd: string | null
  callerCwd: string
  repo: string | null
  mcp: number | null
  mcpError: string | null
  pinnedTransport: TransportName | null
  avoidedAgents: string[]
  distinctModels: string[] | undefined
}) {
  const select = () => {
    try {
      return pick(
        input.job,
        undefined,
        input.pickBytes,
        true,
        stackAt(input.launchCwd ?? input.callerCwd),
        {
          agents: input.avoidedAgents,
          models: input.distinctModels,
          requiredMcp: requiredMcpServer(
            mcpRequestFromStored(input.mcp, input.mcpError),
            input.launchCwd ?? input.callerCwd,
            input.repo ?? undefined,
          ),
          pinnedTransport: input.pinnedTransport ?? undefined,
          project: input.repo,
        },
        false,
        input.lens ?? undefined,
        Math.random,
        { allowHarness: false },
      )
    } catch (error) {
      if (!input.pinnedTransport || error instanceof AgentCapacityError) throw error
      throw new Error(
        `pinned ${input.pinnedTransport} transport left no eligible agent: ${String((error as Error).message ?? error)}`,
      )
    }
  }
  return selectAgentWithCapacityEvents({
    runId: input.runId,
    select,
  })
}

function notifyFailureRequiringHuman(input: {
  failureKind: ReturnType<typeof classify> | null
  billingHoldDetail?: string
  name: string
  job: string
  idleUnkillable: boolean
  runId: string
  endpointKey: EffectiveBillingKey
  projectName: string | null
}): void {
  if (input.failureKind && NEEDS_HUMAN.includes(input.failureKind)) {
    const billingHold = billingHoldForFailure(
      input.failureKind,
      input.name,
      input.billingHoldDetail,
      input.endpointKey.source,
    )
    const routingRemedy =
      input.failureKind === 'billing' && input.endpointKey.source === 'project'
        ? `Project ${input.projectName} secret ${input.endpointKey.secretName} pays for this run; restore that key's OpenRouter balance or limit.`
        : billingHold
          ? `Routing will avoid it: ${billingHold.disabledReason}.`
          : 'Routing will avoid it until it succeeds again.'
    notify(
      NEEDS_HUMAN_TITLE[input.failureKind]?.(input.name) ?? `${input.name} needs attention`,
      `${input.job} failed. ${routingRemedy}`,
    )
  }
  if (input.idleUnkillable)
    notify(
      `${input.name} idle kill did not terminate`,
      `run ${input.runId} still alive after SIGKILL; needs a human`,
    )
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: terminal cleanup and failover share one claimed-run transaction boundary
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
  notifyFailureRequiringHuman({
    failureKind,
    billingHoldDetail: input.billingHoldDetail,
    name,
    job: opts.job,
    idleUnkillable,
    runId: claim.id,
    endpointKey: input.endpointKey,
    projectName: input.endpointKey.projectName,
  })
  if (status === 'failed' && failureKind && FAILS_OVER.includes(failureKind)) {
    // Exclude this coordinator while terminating the vendor so it can route the successor.
    terminateRunProcesses(claim.id, [process.pid])
    const attempts = failoverAttempts(claim.id)
    const tried = attempts.map((attempt) => attempt.agent)
    const first = db()
      .query(
        `SELECT prompt_path, launch_cwd, launch_seed, launch_key, launch_base,
              no_failover, session_id, mcp, mcp_error, schema_path, probe, label, lens, review_role, repo,
              base_commit, head_commit, review_ref, transport, transport_explicit
         FROM run WHERE record_id=?`,
      )
      .get(attempts[0]!.record_id) as {
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
      review_role: ReviewRole | null
      repo: string | null
      base_commit: string | null
      head_commit: string | null
      review_ref: string | null
      transport: TransportName | null
      transport_explicit: number
    }
    const failoverFacts = {
      status,
      failureKind,
      failoverKinds: FAILS_OVER,
      noFailover: Boolean(first.no_failover || opts.noFailover),
      writesJob,
      changes,
      worktree: worktree?.path ?? '(none — read-only job)',
      attemptCount: attempts.length,
      maxAttempts: failoverAttemptLimit(failureKind),
      agentsTried: tried,
      originalPromptAvailable: Boolean(first.prompt_path && existsSync(first.prompt_path)),
    }
    const refusalReason = failoverRefusalReason(decideFailover(failoverFacts))
    if (refusalReason) {
      appendFailoverRefusal(claim.id, refusalReason, failureKind === 'premature-final')
    } else {
      try {
        const originalPrompt = readFileSync(first.prompt_path!, 'utf8')
        const transportConstraints = storedFailoverSelectionConstraints(first, opts, tried)
        const selected = await selectFailoverSuccessor({
          runId: claim.id,
          job: opts.job,
          pickBytes: input.pickBytes,
          lens: first.lens,
          launchCwd: first.launch_cwd,
          callerCwd,
          repo: first.repo,
          mcp: first.mcp,
          mcpError: first.mcp_error,
          pinnedTransport: transportConstraints.pinnedTransport,
          avoidedAgents: transportConstraints.avoidedAgents,
          distinctModels: transportConstraints.distinctModels,
        })
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
        if (artifactsPersisted && worktree && reclaimsTreeByDefault(opts.job))
          reclaimTerminalTree(claim.id, worktree, idleTreePids, idleTreePgid, true)
        return await run({
          job: opts.job,
          prompt: originalPrompt,
          agent: successorAgent,
          transport: transportConstraints.successorTransport,
          schemaPath: first.schema_path ?? undefined,
          mcp: mcpRequestFromStored(first.mcp, first.mcp_error),
          probe: !!first.probe,
          label: first.label ?? undefined,
          lens: first.lens ?? undefined,
          reviewRole: first.review_role ?? undefined,
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
          distinctModels: transportConstraints.distinctModels,
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
        const successor = hasFailoverSuccessor(claim.id)
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
          failureKind === 'premature-final',
        )
      }
    }

    // A successor claim closes the retired attempt with the failover reason.
    // Reaching here means no successor was created, so the failed chain itself
    // is terminal and needs the ordinary terminal close instead.
    writeTransaction(() => {
      closeRunChainQuestions(db(), claim.id, QUESTION_CLOSE_CHAIN_TERMINAL)
    })
  }

  if (
    artifactsPersisted &&
    worktree &&
    reclaimsTreeByDefault(opts.job) &&
    status !== 'asking' &&
    status !== 'running' &&
    status !== 'stopped'
  ) {
    reclaimTerminalTree(claim.id, worktree, idleTreePids, idleTreePgid, true)
  }

  if (status === 'failed') {
    throw Object.assign(new Error(`run ${claim.id} failed: ${error}`), {
      runId: claim.id,
    })
  }
  return {
    record_id: claim.id,
    number: claim.number,
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
