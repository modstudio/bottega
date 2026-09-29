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
import { questionOpenSql } from '../run/question-close.ts'
import type { ResumeTreePlan } from '../run/resume-tree.ts'
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
  projectId: number
  projectName: string
  runIds: number[]
  trunk: string
  worktree: RetryWorktree | null
}

export type DetachSpec = {
  agent?: string
  schema?: string
  mcp?: McpRequest
  model?: string
  probe?: boolean
  transport?: TransportName
  label?: string
  lens?: string
  seed?: string
  key?: string
  repo?: string
  base?: string
  avoid?: string[]
  distinctModels?: string[]
  retryOf?: number
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
    parent: number
    agent: string
    session?: string
    turn: number
    /** A record-only ruling recovery retires the old asking writer atomically with this claim. */
    retireAsking?: boolean
    sessionId: string | null
    worktree: RetryWorktree | null
    treePlan?: Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }>
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

export function chainTransport(rootId: number): TransportName | null {
  const row = db()
    .query(
      `SELECT transport FROM run
      WHERE (id = ? OR parent_run_id = ?) AND transport IS NOT NULL
      ORDER BY turn DESC, id DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { transport: string } | null
  return row?.transport === 'cli' || row?.transport === 'acp' ? row.transport : null
}

export function detachedRunOptions(
  jobName: string,
  prompt: string,
  reserveId: number,
  spec: DetachSpec,
) {
  const {
    agent,
    schema,
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
  // Adding a field to DetachSpec must fail typechecking until it is handled here.
  const consumed: Required<Record<keyof DetachSpec, unknown>> = {
    agent,
    schema,
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
  void consumed
  return {
    job: jobName,
    prompt,
    reserveId,
    agent,
    schemaPath: schema,
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

export const MAX_FAILOVER_ATTEMPTS = 3

export function resolveSupersededTurn(database: Database, rootId: number, turn: number): number {
  return database
    .query(
      `UPDATE run AS prior SET status='ok'
      WHERE prior.parent_run_id=? AND prior.turn=? AND prior.status='asking'
        AND EXISTS (
          SELECT 1 FROM question q
           WHERE q.run_id=prior.id AND q.answered_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM question q
           WHERE q.run_id=prior.id AND ${questionOpenSql('q')}
        )
        AND EXISTS (
          SELECT 1 FROM run later
           WHERE later.parent_run_id=prior.parent_run_id AND later.turn>prior.turn
        )`,
    )
    .run(rootId, turn).changes
}

export type FailoverAttempt = { id: number; agent: string }

export function failoverAttempts(id: number): FailoverAttempt[] {
  const attempts: FailoverAttempt[] = []
  let memberId: number | null = id
  while (memberId) {
    const member = db()
      .query('SELECT id, agent, parent_run_id FROM run WHERE id=?')
      .get(memberId) as { id: number; agent: string; parent_run_id: number | null } | null
    if (!member) break
    const rootId = member.parent_run_id ?? member.id
    const root = db()
      .query('SELECT id, agent, retry_of, automatic_failover FROM run WHERE id=?')
      .get(rootId) as {
      id: number
      agent: string
      retry_of: number | null
      automatic_failover: number
    }
    attempts.unshift({ id: root.id, agent: root.agent })
    memberId = root.automatic_failover ? root.retry_of : null
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
