// concern: failover
/**
 * Knows the agent registry, failure taxonomy, job catalogue, routing evidence
 * reads, and retry identity. Must not know transports, contracts, worktrees, or
 * database write helpers.
 */
import type { Database } from 'bun:sqlite'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import type { McpRequest } from '../mcp/mcp-preflight.ts'
import type { ContinuationMessageBinding } from '../run/continuation-message.ts'
import { questionOpenSql } from '../run/question-open.ts'
import type { ResumeTreePlan } from '../run/resume-tree.ts'
import type { TaskBranchNominatingRun } from '../run/run-types.ts'
import type { KeepTreeExemption } from '../worktree/keep-tree-hold.ts'

type TransportName = 'cli' | 'acp'
type RetryWorktree = {
  path: string
  branch: string
  base: string
  repoRoot: string
  source?: 'recipe' | 'git' | 'clone' | 'readonly_recipe'
  mintedBranch?: string | null
}

export type ResolvedTaskBranch = {
  branch: string
  tip: string
  commitCount: number
  mergeBase: string
  projectId: string
  projectName: string
  nominatingRuns: TaskBranchNominatingRun[]
  trunk: string
  worktree: RetryWorktree | null
  worktreeOwnerJob: string | null
}

export type DetachSpec = {
  agent?: string
  agentExplicit?: boolean
  /** Surface routing result; unlike agent, this is not a caller pin. */
  routedAgent?: { agent: string; reason: string }
  schema?: string
  mcp?: McpRequest
  model?: string
  probe?: boolean
  transport?: TransportName
  transportPinSource?: 'explicit' | 'environment'
  label?: string
  lens?: string
  seed?: string
  key?: string
  repo?: string
  base?: string
  /** Readable branch name retained when an internal chain resume uses base as an immutable commit. */
  launchBase?: string
  avoid?: string[]
  distinctModels?: string[]
  retryOf?: string
  cwd?: string
  launchCwd?: string
  noFailover?: boolean
  noWaitCapacity?: boolean
  carry?: boolean
  review?: string
  ownerSession?: string | null
  deliverables?: string[]
  timeoutMinutes?: number
  keepTree?: KeepTreeExemption
  resolvedTaskBranch?: ResolvedTaskBranch | null
  resume?: {
    kind: 'continue' | 'fresh-session' | 'retry-root'
    parent: string
    agent: string
    session?: string
    turn: number
    /** A record-only ruling recovery retires the old asking writer atomically with this claim. */
    retireAsking?: boolean
    sessionId: string | null
    worktree: RetryWorktree | null
    treePlan?: Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }>
    readOnlyBase?: string
    continuationMessage?: ContinuationMessageBinding
  }
}

export function retryModelForAgent(
  originalAgent: string,
  originalModel: string | null,
  retryAgent: string,
  explicitModel?: string,
): string | undefined {
  if (explicitModel !== undefined) return explicitModel
  if (retryAgent === originalAgent) return originalModel ?? undefined
  const pin = AGENTS[retryAgent]
  if (!pin) throw new Error(`unknown agent "${retryAgent}"`)
  return pin.model
}

export function chainTransport(rootId: string): TransportName | null {
  const row = db()
    .query(
      `SELECT transport FROM run
      WHERE (record_id = ? OR parent_run_record_id = ?) AND transport IS NOT NULL
      ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { transport: string } | null
  return row?.transport === 'cli' || row?.transport === 'acp' ? row.transport : null
}

const detachRouting = (spec: DetachSpec) => ({
  agentExplicit: spec.agentExplicit,
  routedAgent: spec.routedAgent,
})

export function detachedRunOptions(
  jobName: string,
  prompt: string,
  reserveId: string,
  spec: DetachSpec,
) {
  const {
    agent,
    mcp,
    model,
    probe,
    transport,
    label,
    lens,
    seed,
    key,
    repo,
    base,
    launchBase,
    avoid,
    distinctModels,
    retryOf,
    cwd,
    launchCwd,
    noFailover,
    noWaitCapacity,
    carry,
    review,
    ownerSession,
    resume,
    deliverables,
    timeoutMinutes,
    keepTree,
    resolvedTaskBranch,
  } = spec
  const consumed: Required<Record<Exclude<keyof DetachSpec, 'transportPinSource'>, unknown>> = {
    agent,
    ...detachRouting(spec),
    schema: spec.schema,
    mcp,
    model,
    probe,
    transport,
    label,
    lens,
    seed,
    key,
    repo,
    base,
    launchBase,
    avoid,
    distinctModels,
    retryOf,
    cwd,
    launchCwd,
    noFailover,
    noWaitCapacity,
    carry,
    review,
    ownerSession,
    resume,
    deliverables,
    timeoutMinutes,
    keepTree,
    resolvedTaskBranch,
  }
  return {
    job: jobName,
    prompt,
    reserveId,
    agent,
    ...detachRouting(consumed as DetachSpec),
    schemaPath: spec.schema,
    mcp,
    model,
    probe,
    transport,
    label,
    lens,
    seed,
    key,
    repo,
    base,
    launchBase,
    avoid,
    distinctModels,
    retryOf,
    cwd,
    launchCwd,
    noFailover,
    noWaitCapacity,
    carry,
    review,
    ownerSession,
    resume,
    deliverables,
    timeoutMinutes,
    keepTree,
    resolvedTaskBranch,
  }
}

const MAX_FAILOVER_ATTEMPTS = 3
const PREMATURE_FINAL_MAX_FAILOVER_ATTEMPTS = 2

/** A premature final gets one successor; other eligible failures keep the chain budget. */
export function failoverAttemptLimit(failureKind: string): number {
  return failureKind === 'premature-final'
    ? PREMATURE_FINAL_MAX_FAILOVER_ATTEMPTS
    : MAX_FAILOVER_ATTEMPTS
}

export function resolveSupersededTurn(database: Database, rootId: string, turn: number): number {
  return database
    .query(
      `UPDATE run AS prior SET status='ok'
      WHERE prior.parent_run_record_id=? AND prior.turn=? AND prior.status='asking'
        AND EXISTS (
          SELECT 1 FROM question q
           WHERE q.run_record_id=prior.record_id AND q.answered_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM question q
           WHERE q.run_record_id=prior.record_id AND ${questionOpenSql('q')}
        )
        AND EXISTS (
          SELECT 1 FROM run later
           WHERE later.parent_run_record_id=prior.parent_run_record_id AND later.turn>prior.turn
        )`,
    )
    .run(rootId, turn).changes
}

export type FailoverAttempt = { record_id: string; agent: string }

export function failoverAttempts(id: string): FailoverAttempt[] {
  const attempts: FailoverAttempt[] = []
  let memberId: string | null = id
  while (memberId) {
    const member = db()
      .query('SELECT record_id, agent, parent_run_record_id FROM run WHERE record_id=?')
      .get(memberId) as {
      record_id: string
      agent: string
      parent_run_record_id: string | null
    } | null
    if (!member) break
    const rootId = member.parent_run_record_id ?? member.record_id
    const root = db()
      .query(
        'SELECT record_id, agent, retry_of_record_id, automatic_failover FROM run WHERE record_id=?',
      )
      .get(rootId) as {
      record_id: string
      agent: string
      retry_of_record_id: string | null
      automatic_failover: number
    }
    attempts.unshift({ record_id: root.record_id, agent: root.agent })
    memberId = root.automatic_failover ? root.retry_of_record_id : null
  }
  return attempts
}

export function writingFailoverRefusal(
  writesJob: boolean,
  changes: ({ files: string[] } & Record<string, unknown>) | null,
  worktree: string,
): string | null {
  // "Clean" means no change from this run's immutable base, not an empty
  // porcelain status. A worker may commit normally now; changesIn includes
  // those commits, and handing that branch to a second agent would mix two
  // authors' work in the one diff this guard exists to protect.
  if (!writesJob) return null
  if (changes && changes.files.length === 0) return null
  const detail = changes
    ? `${changes.files.length} changed file(s)`
    : 'the worktree diff could not be read'
  return `writing run has ${detail}; preserving worktree ${worktree} so two agents never share one diff`
}

export type FailoverDecision =
  | { kind: 'none' }
  | { kind: 'refusal'; reason: string }
  | { kind: 'select' }
  | { kind: 'successor'; agent: string }

export function failoverRefusalReason(decision: FailoverDecision): string | null {
  return decision.kind === 'refusal' ? decision.reason : null
}

export function failoverSuccessorAgent(decision: FailoverDecision): string {
  if (decision.kind !== 'successor') throw new Error('failover successor was not selected')
  return decision.agent
}

export function decideFailover(facts: {
  status: string
  failureKind: string | null
  failoverKinds: readonly string[]
  noFailover: boolean
  writesJob: boolean
  changes: ({ files: string[] } & Record<string, unknown>) | null
  worktree: string
  attemptCount: number
  maxAttempts: number
  agentsTried: string[]
  originalPromptAvailable: boolean
  successor?: { agent: string } | null
  selectionError?: string
}): FailoverDecision {
  if (
    facts.status !== 'failed' ||
    !facts.failureKind ||
    !facts.failoverKinds.includes(facts.failureKind)
  )
    return { kind: 'none' }
  if (facts.noFailover) {
    return { kind: 'refusal', reason: `disabled by --no-failover; worktree ${facts.worktree}` }
  }
  const writingRefusal = writingFailoverRefusal(facts.writesJob, facts.changes, facts.worktree)
  if (writingRefusal) return { kind: 'refusal', reason: writingRefusal }
  if (facts.attemptCount >= facts.maxAttempts) {
    return {
      kind: 'refusal',
      reason: `the ${facts.maxAttempts}-attempt budget was spent; tried ${facts.agentsTried.join(', ')}; worktree ${facts.worktree}`,
    }
  }
  if (!facts.originalPromptAvailable) {
    return {
      kind: 'refusal',
      reason: `the original prompt is no longer on disk; tried ${facts.agentsTried.join(', ')}; worktree ${facts.worktree}`,
    }
  }
  if (facts.selectionError) {
    return {
      kind: 'refusal',
      reason: `no eligible agent remains after trying ${facts.agentsTried.join(', ')}: ${facts.selectionError}; worktree ${facts.worktree}`,
    }
  }
  if (facts.successor) return { kind: 'successor', agent: facts.successor.agent }
  return { kind: 'select' }
}
