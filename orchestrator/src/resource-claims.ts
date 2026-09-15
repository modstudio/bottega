// concern: resource-claims
/**
 * Knows durable resource claims and their lifecycle states.
 * Must not know resource creation, Git operations, close-out policy, or the CLI.
 */
import type { Database } from 'bun:sqlite'

export const RESOURCE_CLAIM_MIGRATION = '0020_resource_claim'

export const RESOURCE_CLAIM_KINDS = [
  'worktree',
  'branch',
  'retained_ref',
  'sandbox_dir',
  'trust_entry',
  'port',
  'database',
] as const

export type ResourceClaimKind = (typeof RESOURCE_CLAIM_KINDS)[number]
export type ResourceClaimState = 'claimed' | 'released' | 'retained' | 'forgotten' | 'absent'
export type CloseOutClaimOutcome = 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'
export type SandboxDirectoryReleaseInput = {
  terminal: boolean
  liveTurn: boolean
  liveProcess: boolean | null
  worktreeState: ResourceClaimState | 'no-tree'
  keepTree: boolean
  directoryExists: boolean
}
export type SandboxDirectoryReleaseDecision = 'release' | 'absent' | `keep:${string}`

export type RecipeDatabaseProvider = 'postgres-template' | 'mysql-dump' | 'compose'

export type ResourceCreation = 'sandbox_directory' | 'trust_heading' | 'serve_port' | 'database'

export function claimKindForCreation(creation: ResourceCreation): ResourceClaimKind {
  switch (creation) {
    case 'sandbox_directory':
      return 'sandbox_dir'
    case 'trust_heading':
      return 'trust_entry'
    case 'serve_port':
      return 'port'
    case 'database':
      return 'database'
  }
}

export function claimCreationDecision(
  existingRootRunId: number | null,
  requestedRootRunId: number,
): 'record' | 'duplicate' | 'collision' {
  if (existingRootRunId === null) return 'record'
  return existingRootRunId === requestedRootRunId ? 'duplicate' : 'collision'
}

export function settledStateForDatabaseTeardown(
  databaseDropped: boolean,
): Extract<ResourceClaimState, 'released' | 'retained'> {
  return databaseDropped ? 'released' : 'retained'
}

export function settledStateForWorktreeResource(
  worktreeState: Exclude<ResourceClaimState, 'claimed'>,
  kind: ResourceClaimKind,
): ResourceClaimState | null {
  if (worktreeState === 'retained') return null
  if (kind === 'port') return 'released'
  return null
}

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

/** Decide sandbox-home release from conversation liveness and the settled tree outcome. */
export function sandboxDirectoryRelease(
  input: SandboxDirectoryReleaseInput,
): SandboxDirectoryReleaseDecision {
  if (!input.directoryExists) return 'absent'
  if (!input.terminal) return 'keep:conversation is not terminal'
  if (input.liveTurn) return 'keep:conversation has a live turn'
  if (input.liveProcess === null) return 'keep:process liveness could not be established'
  if (input.liveProcess) return 'keep:conversation has a live process'
  if (input.keepTree) return 'keep:held by explicit --keep-tree'
  if (input.worktreeState === 'claimed' || input.worktreeState === 'retained') {
    return 'keep:worktree is still held'
  }
  return 'release'
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
): 'recorded' | 'duplicate' | 'collision' {
  const existing = database
    .query(
      `SELECT root_run_id FROM resource_claim
       WHERE kind=? AND allocation_key=? AND state='claimed'`,
    )
    .get(claim.kind, claim.allocationKey) as { root_run_id: number } | null
  const decision = claimCreationDecision(existing?.root_run_id ?? null, claim.rootRunId)
  if (decision !== 'record') return decision
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
  return 'recorded'
}

export function recordSandboxDirectoryClaim(
  database: Database,
  input: ClaimIdentity & { path: string; claimedAt: string },
): void {
  insertClaim(database, {
    ...input,
    kind: claimKindForCreation('sandbox_directory'),
    allocationKey: input.path,
    identity: input.path,
    label: String(input.rootRunId),
  })
}

export function recordTrustEntryClaims(
  database: Database,
  input: ClaimIdentity & { headings: string[]; storePath: string; claimedAt: string },
): void {
  for (const heading of input.headings) {
    insertClaim(database, {
      ...input,
      kind: claimKindForCreation('trust_heading'),
      allocationKey: heading,
      identity: input.storePath,
      label: String(input.rootRunId),
    })
  }
}

export function recordPortClaim(
  database: Database,
  input: ClaimIdentity & { port: number; claimedAt: string },
): number | null {
  const result = insertClaim(database, {
    ...input,
    kind: claimKindForCreation('serve_port'),
    allocationKey: `port:${input.port}`,
    identity: JSON.stringify({ runId: input.runId, projectId: input.projectId }),
    label: String(input.rootRunId),
  })
  if (result !== 'collision') return null
  const existing = database
    .query(
      `SELECT root_run_id FROM resource_claim
       WHERE kind='port' AND allocation_key=? AND state='claimed'`,
    )
    .get(`port:${input.port}`) as { root_run_id: number }
  return existing.root_run_id
}

export function recordDatabaseClaim(
  database: Database,
  input: ClaimIdentity & {
    provider: RecipeDatabaseProvider
    name: string
    claimedAt: string
  },
): void {
  insertClaim(database, {
    ...input,
    kind: claimKindForCreation('database'),
    allocationKey: `${input.provider}:${input.name}`,
    identity: input.name,
    label: String(input.rootRunId),
  })
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
  const settled = database
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
  if (settled.changes && input.kind === 'worktree') {
    const portState = settledStateForWorktreeResource(input.state, 'port')
    if (portState) {
      database
        .query(
          `UPDATE resource_claim SET state=?, settled_at=?, settled_detail=?
           WHERE root_run_id=? AND kind='port' AND state='claimed'`,
        )
        .run(portState, input.settledAt, `worktree claim settled: ${input.detail}`, input.rootRunId)
    }
  }
}

export function settleDatabaseClaim(
  database: Database,
  input: {
    allocationKey: string
    databaseDropped: boolean
    settledAt: string
    detail: string
  },
): void {
  const state = settledStateForDatabaseTeardown(input.databaseDropped)
  database
    .query(
      `UPDATE resource_claim SET state=?, settled_at=?, settled_detail=?
       WHERE kind='database' AND allocation_key=? AND state='claimed'`,
    )
    .run(state, input.settledAt, input.detail, input.allocationKey)
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

export function claimCounts(database: Database): {
  claimed: number
  terminal: number
  byKind: { kind: ResourceClaimKind; count: number }[]
} {
  const claimed = database
    .query("SELECT COUNT(*) count FROM resource_claim WHERE state='claimed'")
    .get() as { count: number }
  return {
    claimed: claimed.count,
    byKind: RESOURCE_CLAIM_KINDS.map((kind) => ({
      kind,
      count: (
        database
          .query("SELECT COUNT(*) count FROM resource_claim WHERE state='claimed' AND kind=?")
          .get(kind) as { count: number }
      ).count,
    })),
    terminal: claimedClaimsOnTerminalConversations(database).reduce(
      (total, group) => total + group.count,
      0,
    ),
  }
}
