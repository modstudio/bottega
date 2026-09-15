// concern: resource-claims
/**
 * Knows durable resource claims and their lifecycle states.
 * Must not know resource creation, Git operations, close-out policy, or the CLI.
 */
import type { Database } from 'bun:sqlite'

export const RESOURCE_CLAIM_MIGRATION = '0020_resource_claim'
export const RECIPE_PORT_BAND: PortBand = { start: 21000, end: 25000 }

export const RESOURCE_CLAIM_KINDS = [
  'worktree',
  'branch',
  'retained_ref',
  'sandbox_dir',
  'trust_entry',
  'port',
  'database',
  'index',
  'string',
] as const

export type ResourceClaimKind = (typeof RESOURCE_CLAIM_KINDS)[number]
export type ResourceClaimState = 'claimed' | 'released' | 'retained' | 'forgotten' | 'absent'
export type PortBand = { start: number; end: number }
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

export function lowestFreePort(band: PortBand, claimedPorts: readonly number[]): number | null {
  const claimed = new Set(claimedPorts)
  for (let port = band.start; port < band.end; port++) {
    if (!claimed.has(port)) return port
  }
  return null
}

export function recipePortAllocation(
  band: PortBand,
  claimedPorts: readonly number[],
  existingClaimedPort: number | null,
): { action: 'reuse' | 'claim'; port: number } | { action: 'full' } {
  if (existingClaimedPort !== null) return { action: 'reuse', port: existingClaimedPort }
  const port = lowestFreePort(band, claimedPorts)
  return port === null ? { action: 'full' } : { action: 'claim', port }
}

export function indexAllocation(
  claimedIndexes: readonly number[],
  existingClaimedIndex: number | null,
): { action: 'reuse' | 'claim'; index: number } {
  if (existingClaimedIndex !== null) return { action: 'reuse', index: existingClaimedIndex }
  const claimed = new Set(claimedIndexes)
  let index = 1
  while (claimed.has(index)) index++
  return { action: 'claim', index }
}

export function stringClaimDecision(
  existingValue: string | null,
  heldByRootRunId: number | null,
  requestedRootRunId: number,
): 'reuse' | 'claim' | 'collision' {
  if (existingValue !== null) return 'reuse'
  if (heldByRootRunId === null) return 'claim'
  return heldByRootRunId === requestedRootRunId ? 'reuse' : 'collision'
}

export function fillStringAllocationTemplate(
  name: string,
  template: string,
  vars: Record<string, string>,
): string {
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    if (!(match[1]! in vars)) {
      throw new Error(`unavailable placeholder {${match[1]}} in string allocation "${name}"`)
    }
  }
  return template.replace(/\{([^{}]+)\}/g, (_placeholder, key: string) => vars[key]!)
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
  if (kind === 'port' || kind === 'index' || kind === 'string') return 'released'
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

export function claimRecipePort(
  database: Database,
  input: ClaimIdentity & { claimedAt: string; band: PortBand; name?: string },
): number {
  const nameFilter =
    input.name === undefined
      ? "json_type(identity,'$.name') IS NULL"
      : "json_extract(identity,'$.name')=?"
  const existing = database
    .query(
      `SELECT allocation_key FROM resource_claim
       WHERE root_run_id=? AND kind='port' AND state='claimed'
         AND ${nameFilter}
       ORDER BY id DESC LIMIT 1`,
    )
    .get(...(input.name === undefined ? [input.rootRunId] : [input.rootRunId, input.name])) as {
    allocation_key: string
  } | null
  const existingPort = existing ? Number(existing.allocation_key.slice('port:'.length)) : null
  const claimedPorts = (
    database
      .query("SELECT allocation_key FROM resource_claim WHERE kind='port' AND state='claimed'")
      .all() as { allocation_key: string }[]
  ).map((row) => Number(row.allocation_key.slice('port:'.length)))
  const attempted = new Set(claimedPorts)
  const bandSize = input.band.end - input.band.start

  for (let attempt = 0; attempt < bandSize; attempt++) {
    const decision = recipePortAllocation(input.band, [...attempted], existingPort)
    if (decision.action === 'full') break
    if (decision.action === 'reuse') return decision.port
    try {
      database
        .query(
          `INSERT INTO resource_claim
           (root_run_id,run_id,project_id,kind,allocation_key,identity,label,state,claimed_at)
           VALUES (?,?,?,'port',?,?,?,'claimed',?)`,
        )
        .run(
          input.rootRunId,
          input.runId,
          input.projectId,
          `port:${decision.port}`,
          JSON.stringify({
            runId: input.runId,
            projectId: input.projectId,
            ...(input.name === undefined ? {} : { name: input.name }),
          }),
          String(input.rootRunId),
          input.claimedAt,
        )
      return decision.port
    } catch (error) {
      if (!String((error as Error)?.message ?? error).includes('UNIQUE constraint failed')) {
        throw error
      }
      attempted.add(decision.port)
    }
  }

  const liveClaims = (
    database
      .query(
        `SELECT COUNT(*) count FROM resource_claim
         WHERE kind='port' AND state='claimed'
           AND CAST(SUBSTR(allocation_key, 6) AS INTEGER)>=?
           AND CAST(SUBSTR(allocation_key, 6) AS INTEGER)<?`,
      )
      .get(input.band.start, input.band.end) as { count: number }
  ).count
  throw new Error(
    `recipe port band [${input.band.start}, ${input.band.end}) is full: ${liveClaims} live claims`,
  )
}

export function claimIndex(
  database: Database,
  input: ClaimIdentity & { projectId: number; claimedAt: string },
): number {
  const existing = database
    .query(
      `SELECT allocation_key FROM resource_claim
       WHERE root_run_id=? AND project_id=? AND kind='index' AND state='claimed'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(input.rootRunId, input.projectId) as { allocation_key: string } | null
  const existingIndex = existing ? Number(existing.allocation_key.split(':').at(-1)) : null
  const claimedIndexes = (
    database
      .query(
        `SELECT allocation_key FROM resource_claim
         WHERE project_id=? AND kind='index' AND state='claimed'`,
      )
      .all(input.projectId) as { allocation_key: string }[]
  ).map((row) => Number(row.allocation_key.split(':').at(-1)))
  const attempted = new Set(claimedIndexes)

  while (true) {
    const decision = indexAllocation([...attempted], existingIndex)
    if (decision.action === 'reuse') return decision.index
    try {
      database
        .query(
          `INSERT INTO resource_claim
           (root_run_id,run_id,project_id,kind,allocation_key,identity,label,state,claimed_at)
           VALUES (?,?,?,'index',?,?,?,'claimed',?)`,
        )
        .run(
          input.rootRunId,
          input.runId,
          input.projectId,
          `index:${input.projectId}:${decision.index}`,
          JSON.stringify({ runId: input.runId, projectId: input.projectId }),
          String(input.rootRunId),
          input.claimedAt,
        )
      return decision.index
    } catch (error) {
      if (!String((error as Error)?.message ?? error).includes('UNIQUE constraint failed')) {
        throw error
      }
      attempted.add(decision.index)
    }
  }
}

export function claimString(
  database: Database,
  input: ClaimIdentity & { projectId: number; name: string; value: string; claimedAt: string },
): string {
  const existing = database
    .query(
      `SELECT allocation_key FROM resource_claim
       WHERE root_run_id=? AND project_id=? AND kind='string' AND state='claimed'
         AND json_extract(identity,'$.name')=?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(input.rootRunId, input.projectId, input.name) as { allocation_key: string } | null
  const existingValue = existing
    ? existing.allocation_key.slice(`string:${input.projectId}:`.length)
    : null
  const allocationKey = `string:${input.projectId}:${input.value}`
  const holder = database
    .query(
      `SELECT root_run_id FROM resource_claim
       WHERE kind='string' AND allocation_key=? AND state='claimed'`,
    )
    .get(allocationKey) as { root_run_id: number } | null
  const decision = stringClaimDecision(existingValue, holder?.root_run_id ?? null, input.rootRunId)
  if (decision === 'reuse') return existingValue ?? input.value
  if (decision === 'collision') {
    throw new Error(
      `string allocation "${input.name}" value "${input.value}" is held by run ${holder!.root_run_id}; include {index} in its template`,
    )
  }
  try {
    database
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,project_id,kind,allocation_key,identity,label,state,claimed_at)
         VALUES (?,?,?,'string',?,?,?,'claimed',?)`,
      )
      .run(
        input.rootRunId,
        input.runId,
        input.projectId,
        allocationKey,
        JSON.stringify({ runId: input.runId, projectId: input.projectId, name: input.name }),
        String(input.rootRunId),
        input.claimedAt,
      )
    return input.value
  } catch (error) {
    if (!String((error as Error)?.message ?? error).includes('UNIQUE constraint failed'))
      throw error
    const collided = database
      .query(
        `SELECT root_run_id FROM resource_claim
         WHERE kind='string' AND allocation_key=? AND state='claimed'`,
      )
      .get(allocationKey) as { root_run_id: number }
    throw new Error(
      `string allocation "${input.name}" value "${input.value}" is held by run ${collided.root_run_id}; include {index} in its template`,
    )
  }
}

export function releaseRecipeAllocationClaims(
  database: Database,
  input: { claimIds: readonly number[]; settledAt: string; reason: string },
): void {
  const update = database.query(
    `UPDATE resource_claim SET state='released',settled_at=?,settled_detail=?
     WHERE id=? AND state='claimed' AND kind IN ('port','index','string')`,
  )
  for (const id of input.claimIds) {
    update.run(input.settledAt, `tracked creation failed: ${input.reason}`, id)
  }
}

export function recipePortClaimForRun(database: Database, runId: number): number | null {
  const claim = database
    .query(
      `SELECT allocation_key FROM resource_claim
       WHERE root_run_id=(SELECT COALESCE(parent_run_id,id) FROM run WHERE id=?)
         AND kind='port'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as { allocation_key: string } | null
  if (!claim) return null
  const port = Number(claim.allocation_key.slice('port:'.length))
  return Number.isInteger(port) ? port : null
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
    const allocationState = settledStateForWorktreeResource(input.state, 'port')
    if (allocationState) {
      database
        .query(
          `UPDATE resource_claim SET state=?, settled_at=?, settled_detail=?
           WHERE root_run_id=? AND kind IN ('port','index','string') AND state='claimed'`,
        )
        .run(
          allocationState,
          input.settledAt,
          `worktree claim settled: ${input.detail}`,
          input.rootRunId,
        )
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
