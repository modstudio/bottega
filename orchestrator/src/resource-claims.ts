// concern: resource-claims
/**
 * Knows durable claims on git-level resources and their lifecycle states.
 * Must not know resource creation, Git operations, close-out policy, or the CLI.
 */
import type { Database } from 'bun:sqlite'

export const RESOURCE_CLAIM_MIGRATION = '0020_resource_claim'

export type ResourceClaimKind = 'worktree' | 'branch' | 'retained_ref'
export type ResourceClaimState = 'claimed' | 'released' | 'retained' | 'forgotten' | 'absent'
export type CloseOutClaimOutcome = 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'

export function createdWorktreeClaimKinds(input: {
  owned: boolean
  mintedBranch: string | null
}): ResourceClaimKind[] {
  if (!input.owned) return []
  return input.mintedBranch ? ['worktree', 'branch'] : ['worktree']
}

export function settledStateForCloseOut(
  outcome: CloseOutClaimOutcome,
  kind: ResourceClaimKind,
): ResourceClaimState | null {
  if (kind === 'worktree' && outcome === 'released') return 'released'
  if (kind === 'worktree' && outcome === 'forgotten') return 'forgotten'
  if (kind === 'worktree' && outcome === 'absent') return 'absent'
  if (kind === 'branch' && outcome === 'released') return 'retained'
  return null
}

type ClaimIdentity = {
  rootRunId: number
  runId: number
  projectId: number | null
}

function insertClaim(
  database: Database,
  claim: ClaimIdentity & {
    kind: ResourceClaimKind
    allocationKey: string
    identity: string | null
    label: string | null
    claimedAt: string
  },
): void {
  const existing = database
    .query(
      `SELECT root_run_id FROM resource_claim
       WHERE kind=? AND allocation_key=? AND state='claimed'`,
    )
    .get(claim.kind, claim.allocationKey) as { root_run_id: number } | null
  if (existing?.root_run_id === claim.rootRunId) return
  database
    .query(
      `INSERT INTO resource_claim
       (root_run_id,run_id,project_id,kind,allocation_key,identity,label,state,claimed_at)
       VALUES (?,?,?,?,?,?,?,'claimed',?)`,
    )
    .run(
      claim.rootRunId,
      claim.runId,
      claim.projectId,
      claim.kind,
      claim.allocationKey,
      claim.identity,
      claim.label,
      claim.claimedAt,
    )
}

export function recordCreatedWorktreeClaims(
  database: Database,
  input: ClaimIdentity & {
    owned: boolean
    path: string
    head: string
    mintedBranch: string | null
    label: string
    claimedAt: string
  },
): void {
  for (const kind of createdWorktreeClaimKinds({
    owned: input.owned,
    mintedBranch: input.mintedBranch,
  })) {
    const branch = input.mintedBranch
    insertClaim(database, {
      ...input,
      kind,
      allocationKey: kind === 'worktree' ? input.path : `refs/heads/${branch}`,
      identity:
        kind === 'worktree' ? JSON.stringify({ path: input.path, head: input.head }) : input.head,
    })
  }
}

export function recordRetainedRefClaim(
  database: Database,
  input: ClaimIdentity & {
    ref: string
    tip: string
    claimedAt: string
  },
): void {
  insertClaim(database, {
    ...input,
    kind: 'retained_ref',
    allocationKey: input.ref,
    identity: input.tip,
    label: null,
  })
}

export function settleClaims(
  database: Database,
  input: {
    rootRunId: number
    kind: ResourceClaimKind
    state: Exclude<ResourceClaimState, 'claimed'>
    settledAt: string
    detail: string
    allocationKey?: string
  },
): void {
  database
    .query(
      `UPDATE resource_claim SET state=?, settled_at=?, settled_detail=?
       WHERE root_run_id=? AND kind=?
         AND (state='claimed' OR (?='released' AND state='retained'))
         AND (? IS NULL OR allocation_key=?)`,
    )
    .run(
      input.state,
      input.settledAt,
      input.detail,
      input.rootRunId,
      input.kind,
      input.state,
      input.allocationKey ?? null,
      input.allocationKey ?? null,
    )
}

export function claimedClaimsOnTerminalConversations(
  database: Database,
): { kind: ResourceClaimKind; count: number }[] {
  return database
    .query(
      `SELECT resource_claim.kind, COUNT(*) count
       FROM resource_claim JOIN run ON run.id=resource_claim.root_run_id
       WHERE resource_claim.state='claimed' AND run.status IN ('ok','failed','stale','stopped')
       GROUP BY resource_claim.kind ORDER BY resource_claim.kind`,
    )
    .all() as { kind: ResourceClaimKind; count: number }[]
}

export function claimCounts(database: Database): { claimed: number; terminal: number } {
  const claimed = database
    .query("SELECT COUNT(*) count FROM resource_claim WHERE state='claimed'")
    .get() as { count: number }
  return {
    claimed: claimed.count,
    terminal: claimedClaimsOnTerminalConversations(database).reduce(
      (total, group) => total + group.count,
      0,
    ),
  }
}
