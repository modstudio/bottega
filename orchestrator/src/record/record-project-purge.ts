// concern: record-project-purge
/** Guards and atomically purges one hosted project's owned rows. */
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import { PROJECT_PURGE_PLAN, type RecordTeardownReach } from './record-space-teardown-plan.ts'

class RecordProjectPurgeError extends Error {
  readonly status = 422
}
export type ProjectPurgeFacts = {
  exists: boolean
  name: string
  confirmation: string
  spaceSlug: string
  callerRole: string | null
  publiclyListed: boolean
}
export type ProjectPurgeDecision =
  | { allowed: true; nothing: boolean }
  | { allowed: false; refusal: string }
export type RecordProjectPurgeResult = {
  nothingToRemove: boolean
  tables: Array<{ table: string; count: number }>
  project: number
}

export function decideProjectPurge(facts: ProjectPurgeFacts): ProjectPurgeDecision {
  if (!facts.exists) return { allowed: true, nothing: true }
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

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const tuple = (columns: readonly string[]) =>
  columns.length === 1 ? identifier(columns[0]!) : `(${columns.map(identifier).join(',')})`
const selectList = (columns: readonly string[]) => columns.map(identifier).join(',')
const steps = new Map(PROJECT_PURGE_PLAN.map((step) => [step.table, step]))
function reachPredicate(reach: RecordTeardownReach): string {
  if (reach.parent === 'project')
    return `${tuple(reach.columns)} IN (SELECT ${selectList(reach.parentColumns)} FROM project WHERE id=$1)`
  const parent = steps.get(reach.parent)
  if (!parent) throw new Error(`project purge parent is not planned: ${reach.parent}`)
  return `${tuple(reach.columns)} IN (SELECT ${selectList(reach.parentColumns)} FROM ${identifier(reach.parent)} WHERE ${purgePredicate(parent.table)})`
}
function purgePredicate(table: string): string {
  const step = steps.get(table)
  if (!step) throw new Error(`project purge table is not planned: ${table}`)
  return `(${step.reachedBy.map(reachPredicate).join(' OR ')})`
}

export async function purgeRecordProject(input: {
  url: string
  userId: string
  spaceId: string
  id: string
  confirmation: string
}): Promise<RecordProjectPurgeResult> {
  return recordPool(input.url).begin(async (tx: SQL) => {
    await bindTenant(tx, { userId: input.userId, spaceId: input.spaceId })
    const rows = await tx`
      SELECT p.name,s.slug,m.role
      FROM project p
      JOIN space s ON s.id=p.space_id
      LEFT JOIN membership m ON m.space_id=p.space_id AND m.user_id=${input.userId}::uuid
      WHERE p.id=${input.id}::uuid
      FOR UPDATE OF p
    `
    const row = rows[0]
    if (!row) return { nothingToRemove: true, tables: [], project: 0 }
    const listed =
      await tx`SELECT 1 FROM public_doc_space WHERE project_id=${input.id}::uuid LIMIT 1`
    const decision = decideProjectPurge({
      exists: true,
      name: String(row.name),
      confirmation: input.confirmation,
      spaceSlug: String(row.slug),
      callerRole: row.role === null ? null : String(row.role),
      publiclyListed: listed.length > 0,
    })
    if (!decision.allowed) throw new RecordProjectPurgeError(decision.refusal)
    const tables: RecordProjectPurgeResult['tables'] = []
    for (const step of PROJECT_PURGE_PLAN) {
      const deleted = await tx.unsafe(
        `DELETE FROM ${identifier(step.table)} WHERE ${purgePredicate(step.table)} RETURNING 1`,
        [input.id],
      )
      tables.push({ table: step.table, count: deleted.length })
    }
    const projects = await tx`DELETE FROM project WHERE id=${input.id}::uuid RETURNING id`
    return { nothingToRemove: false, tables, project: projects.length }
  })
}
