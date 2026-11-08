// concern: resource-step-recorder
/** Records resource creation intent before an effect and completes the same row afterwards. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { writeTransaction } from '../database/db.ts'
import type { ResourceClaimKind } from './resource-claims.ts'

export type ClaimIdentity = {
  rootRunId: string
  runId: string
  projectId: string | null
}

export type ResourceStepInput = ClaimIdentity & {
  kind: ResourceClaimKind
  allocationKey: string
  identity: string | null
  label: string | null
  claimedAt: string
  lifetime?: 'runtime' | 'kept'
  shared?: boolean
}

export type ResourceStep = { recordId: string; stepNo: number }

export function insertClaim(
  database: Database,
  claim: ResourceStepInput,
): 'recorded' | 'duplicate' | 'collision' {
  const existing = database
    .query(
      `SELECT root_run_record_id FROM resource_claim
       WHERE kind=? AND allocation_key=? AND state='claimed' AND shared=0`,
    )
    .get(claim.kind, claim.allocationKey) as { root_run_record_id: string } | null
  if (existing) return existing.root_run_record_id === claim.rootRunId ? 'duplicate' : 'collision'
  database
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at)
       VALUES (?,?,?,?,?,?,?,?,'claimed',?)`,
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
    )
  return 'recorded'
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
         VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
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
): Promise<T> {
  const step = beginResourceStep(database, input)
  const result = await effect()
  completeResourceStep(database, step, completion?.(result))
  return result
}
