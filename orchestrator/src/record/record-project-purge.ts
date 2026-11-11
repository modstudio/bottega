// concern: record-project-purge
/** Guards and atomically purges one hosted project's owned rows. */
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import {
  RecordProjectPurgeError,
  type RecordProjectPurgeResult,
} from './record-project-purge-contract.ts'
import {
  buildRecordTeardownPredicates,
  PROJECT_PURGE_PLAN,
} from './record-space-teardown-plan.ts'
export type ProjectPurgeFacts = {
  exists: boolean
  name: string
  confirmation: string
  spaceSlug: string
  declaredSpaceMatches: boolean
  callerRole: string | null
  publiclyListed: boolean
}
export type ProjectPurgeDecision =
  | { allowed: true; nothing: boolean }
  | { allowed: false; refusal: string }
export function decideProjectPurge(facts: ProjectPurgeFacts): ProjectPurgeDecision {
  if (!facts.exists) return { allowed: true, nothing: true }
  if (!facts.declaredSpaceMatches)
    return {
      allowed: false,
      refusal: `declared-space guard failed: project ${facts.name} lives in record space ${facts.spaceSlug}; run \`${PLATFORM_SLUG} project set ${facts.name} --space ${facts.spaceSlug}\`, then retry \`${PLATFORM_SLUG} project purge ${facts.name} --confirm ${facts.name}\``,
    }
  if (facts.confirmation !== facts.name)
    return {
      allowed: false,
      refusal: `confirmation guard failed: --confirm must equal ${facts.name}; run \`${PLATFORM_SLUG} project purge ${facts.name} --confirm ${facts.name}\``,
    }
  if (facts.callerRole !== 'owner')
    return {
      allowed: false,
      refusal: `caller-owner guard failed: ask an owner of ${facts.spaceSlug} to run \`${PLATFORM_SLUG} project purge ${facts.name} --confirm ${facts.name}\``,
    }
  if (facts.publiclyListed)
    return {
      allowed: false,
      refusal: `public-listing guard failed: project ${facts.name} is publicly listed in public_doc_space; ask record_owner to remove that row, then retry`,
    }
  return { allowed: true, nothing: false }
}

const purgeSql = buildRecordTeardownPredicates(PROJECT_PURGE_PLAN, 'project', 'id=$1')

export async function purgeRecordProject(input: {
  url: string
  userId: string
  spaceId: string
  spaceIds: string[]
  id: string
  confirmation: string
}): Promise<RecordProjectPurgeResult> {
  return recordPool(input.url).begin(async (tx: SQL) => {
    await bindTenant(tx, {
      userId: input.userId,
      spaceId: input.spaceId,
      spaceIds: input.spaceIds,
    })
    const rows = await tx`
      SELECT p.name,p.space_id,s.slug,m.role
      FROM project p
      JOIN space s ON s.id=p.space_id
      LEFT JOIN membership m ON m.space_id=p.space_id AND m.user_id=${input.userId}::uuid
      WHERE p.id=${input.id}::uuid
      FOR UPDATE OF p
    `
    const row = rows[0]
    const decision = decideProjectPurge({
      exists: Boolean(row),
      name: row ? String(row.name) : input.confirmation,
      confirmation: input.confirmation,
      spaceSlug: row ? String(row.slug) : '',
      declaredSpaceMatches: row ? String(row.space_id) === input.spaceId : false,
      callerRole: row?.role === null || row === undefined ? null : String(row.role),
      publiclyListed: row
        ? (await tx`SELECT 1 FROM public_doc_space WHERE project_id=${input.id}::uuid LIMIT 1`)
            .length > 0
        : false,
    })
    if (!decision.allowed) throw new RecordProjectPurgeError(decision.refusal)
    if (decision.nothing) return { nothingToRemove: true, tables: [], project: 0 }
    const tables: RecordProjectPurgeResult['tables'] = []
    for (const step of PROJECT_PURGE_PLAN) {
      const deleted = await tx.unsafe(
        `DELETE FROM ${purgeSql.identifier(step.table)} WHERE ${purgeSql.predicate(step.table)} RETURNING 1`,
        [input.id],
      )
      tables.push({ table: step.table, count: deleted.length })
    }
    const projects = await tx`DELETE FROM project WHERE id=${input.id}::uuid RETURNING id`
    if (projects.length !== 1)
      throw new Error(`project purge invariant failed: expected to delete one project row, deleted ${projects.length}`)
    return { nothingToRemove: false, tables, project: projects.length }
  })
}
