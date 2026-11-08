// concern: resource-step-recorder
/** Records resource creation intent before an effect and completes the same row afterwards. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { writeTransaction } from '../database/db.ts'

export const RESOURCE_CLAIM_KINDS = [
  'worktree',
  'branch',
  'retained_ref',
  'sandbox_dir',
  'trust_entry',
  'ref_guard',
  'run_lease',
  'port',
  'database',
  'index',
  'string',
] as const

export type ResourceClaimKind = (typeof RESOURCE_CLAIM_KINDS)[number]

export type ClaimOwner = {
  rootRunId: string
  runId: string
  projectId: string | null
}

export type ResourceStepInput = ClaimOwner & {
  kind: ResourceClaimKind
  allocationKey: string
  identity: string | null
  label: string | null
  claimedAt: string
  lifetime?: 'runtime' | 'kept'
  shared?: boolean
}

export type ResourceStep = { recordId: string; stepNo: number }

export function claimCreationDecision(
  existingRootRunId: string | null,
  requestedRootRunId: string,
  shared = false,
): 'record' | 'duplicate' | 'collision' {
  if (existingRootRunId === null) return 'record'
  if (existingRootRunId === requestedRootRunId) return 'duplicate'
  return shared ? 'record' : 'collision'
}

function existingLiveClaim(
  database: Database,
  input: Pick<ResourceStepInput, 'kind' | 'allocationKey' | 'rootRunId' | 'shared'>,
): { record_id: string; root_run_record_id: string } | null {
  return database
    .query<{ record_id: string; root_run_record_id: string }, [string, string, string, string]>(
      `SELECT record_id,root_run_record_id FROM resource_claim
       WHERE kind=? AND allocation_key=? AND state='claimed'
         AND (root_run_record_id=? OR shared=0)
       ORDER BY (root_run_record_id=? ) DESC,shared ASC,record_id
       LIMIT 1`,
    )
    .get(input.kind, input.allocationKey, input.rootRunId, input.rootRunId)
}

export function insertClaim(
  database: Database,
  claim: ResourceStepInput,
): 'recorded' | 'duplicate' | 'collision' {
  const existing = existingLiveClaim(database, claim)
  const decision = claimCreationDecision(
    existing?.root_run_record_id ?? null,
    claim.rootRunId,
    claim.shared ?? false,
  )
  if (decision !== 'record') return decision
  database
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at,lifetime,shared)
       VALUES (?,?,?,?,?,?,?,?,'claimed',?,?,?)`,
    )
    .run(
      newRecordId(),
      claim.rootRunId,
      claim.runId,
      claim.projectId,
      claim.kind,
      claim.allocationKey,
      claim.identity,
      claim.label,
      claim.claimedAt,
      claim.lifetime ?? 'runtime',
      claim.shared ? 1 : 0,
    )
  return 'recorded'
}

/** Mark a failed pending creation discoverable without allowing later transitions to overwrite it. */
export function markResourceStepStuck(
  database: Database,
  step: ResourceStep,
  detail: string,
  settledAt: string,
): void {
  const result = database
    .query(
      `UPDATE resource_claim SET state='stuck',settled_at=?,settled_detail=?
       WHERE record_id=? AND state='pending'`,
    )
    .run(settledAt, detail, step.recordId)
  if (result.changes !== 1) throw new Error(`pending resource step ${step.recordId} was not found`)
}

/** Write the ordered intent in its own transaction, before the resource effect begins. */
export function beginResourceStep(database: Database, input: ResourceStepInput): ResourceStep {
  return writeTransaction(() => {
    const row = database
      .query<{ step_no: number }, [string]>(
        `SELECT COALESCE(MAX(step_no),0)+1 step_no
         FROM resource_claim WHERE root_run_record_id=?`,
      )
      .get(input.rootRunId)!
    const recordId = newRecordId()
    database
      .query(
        `INSERT INTO resource_claim
         (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
          identity,label,state,claimed_at,step_no,lifetime,shared)
         VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
      )
      .run(
        recordId,
        input.rootRunId,
        input.runId,
        input.projectId,
        input.kind,
        input.allocationKey,
        input.identity,
        input.label,
        input.claimedAt,
        row.step_no,
        input.lifetime ?? 'runtime',
        input.shared ? 1 : 0,
      )
    return { recordId, stepNo: row.step_no }
  }, database)
}

export function completeResourceStep(
  database: Database,
  step: ResourceStep,
  completion: { allocationKey?: string; identity?: string | null } = {},
): void {
  const pending = database
    .query<
      {
        root_run_record_id: string
        kind: ResourceClaimKind
        allocation_key: string
        shared: number
      },
      [string]
    >(
      `SELECT root_run_record_id,kind,allocation_key,shared
       FROM resource_claim WHERE record_id=? AND state='pending'`,
    )
    .get(step.recordId)
  if (!pending) throw new Error(`pending resource step ${step.recordId} was not found`)
  const allocationKey = completion.allocationKey ?? pending.allocation_key
  const existing = existingLiveClaim(database, {
    rootRunId: pending.root_run_record_id,
    kind: pending.kind,
    allocationKey,
    shared: pending.shared === 1,
  })
  const decision = claimCreationDecision(
    existing?.root_run_record_id ?? null,
    pending.root_run_record_id,
    pending.shared === 1,
  )
  if (decision === 'collision') {
    throw new Error(
      `${pending.kind} resource ${allocationKey} is already claimed by ${existing!.root_run_record_id}`,
    )
  }
  if (decision === 'duplicate') {
    database
      .query(
        `UPDATE resource_claim
         SET state='absent',allocation_key=?,settled_at=?,settled_detail=?
         WHERE record_id=? AND state='pending'`,
      )
      .run(
        allocationKey,
        new Date().toISOString(),
        `duplicate of existing resource claim ${existing!.record_id}`,
        step.recordId,
      )
    return
  }
  const result = database
    .query(
      `UPDATE resource_claim
       SET state='claimed',allocation_key=COALESCE(?,allocation_key),
           identity=CASE WHEN ? THEN ? ELSE identity END
       WHERE record_id=? AND state='pending'`,
    )
    .run(
      completion.allocationKey ?? null,
      Object.hasOwn(completion, 'identity') ? 1 : 0,
      completion.identity ?? null,
      step.recordId,
    )
  if (result.changes !== 1) throw new Error(`pending resource step ${step.recordId} was not found`)
}

/** Bracket one synchronous resource effect; a thrown effect deliberately leaves pending intent. */
export function recordResourceStep<T>(
  database: Database,
  input: ResourceStepInput,
  effect: () => T,
  completion?: (result: T) => { allocationKey?: string; identity?: string | null },
): T {
  const step = beginResourceStep(database, input)
  const result = effect()
  completeResourceStep(database, step, completion?.(result))
  return result
}

export async function recordResourceStepAsync<T>(
  database: Database,
  input: ResourceStepInput,
  effect: () => Promise<T>,
  completion?: (result: T) => { allocationKey?: string; identity?: string | null },
  begunStep?: ResourceStep,
): Promise<T> {
  const step = begunStep ?? beginResourceStep(database, input)
  const result = await effect()
  completeResourceStep(database, step, completion?.(result))
  return result
}
