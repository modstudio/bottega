// concern: record-trial-space-delete
/** Guards and atomically tears down marked trial spaces. Never deletes users or personal spaces. */
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bindTenant } from '../../../shared/record/tenant.ts'
import {
  isTrialSpaceMetadata,
  TRIAL_IDENTIFIER_PREFIX,
} from './record-trial-space.ts'
import { recordPool } from './record-pool.ts'
import { SPACE_TEARDOWN_PLAN, type SpaceTeardownReach } from './record-space-teardown-plan.ts'
import {
  TrialSpaceDeleteError,
  type TrialSpaceDeleteResult,
} from './record-trial-space-contract.ts'

type TrialMemberFact = { userId: string; email: string; role: string; hasRealSpace: boolean }
export type TrialDeleteFacts = {
  exists: boolean
  slug: string
  marked: boolean
  callerUserId: string
  members: TrialMemberFact[]
}
export type TrialDeleteDecision =
  | { allowed: true; nothing: boolean; neutralize: TrialMemberFact[] }
  | { allowed: false; refusal: string }
const retry = `choose a space created with \`${PLATFORM_SLUG} record space create --trial\``
export function decideTrialSpaceDelete(facts: TrialDeleteFacts): TrialDeleteDecision {
  if (!facts.exists) return { allowed: true, nothing: true, neutralize: [] }
  if (!facts.slug.startsWith(TRIAL_IDENTIFIER_PREFIX))
    return {
      allowed: false,
      refusal: `trial-slug guard failed: ${facts.slug} does not start with ${TRIAL_IDENTIFIER_PREFIX}; ${retry}`,
    }
  if (!facts.marked)
    return {
      allowed: false,
      refusal: `trial-marker guard failed: ${facts.slug} has no metadata.trial marker; ${retry}`,
    }
  if (facts.members.find((member) => member.userId === facts.callerUserId)?.role !== 'owner')
    return {
      allowed: false,
      refusal: `caller-owner guard failed: ask an owner of ${facts.slug} to run delete-trial`,
    }
  for (const member of facts.members) {
    if (member.userId === facts.callerUserId) continue
    if (!member.email.startsWith(TRIAL_IDENTIFIER_PREFIX))
      return {
        allowed: false,
        refusal: `trial-member-email guard failed: ${member.email} is not a trial account; remove that member, then retry`,
      }
    if (member.hasRealSpace)
      return {
        allowed: false,
        refusal: `trial-member-spaces guard failed: ${member.email} belongs to a non-trial space; remove that member, then retry`,
      }
  }
  return {
    allowed: true,
    nothing: false,
    neutralize: facts.members.filter((member) => member.userId !== facts.callerUserId),
  }
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const tuple = (columns: readonly string[]) =>
  columns.length === 1 ? identifier(columns[0]!) : `(${columns.map(identifier).join(',')})`
const teardownByTable = new Map(SPACE_TEARDOWN_PLAN.map((step) => [step.table, step]))
function reachPredicate(reach: SpaceTeardownReach): string {
  if (reach.parent === 'space') return `${tuple(reach.columns)}=$1`
  const parent = teardownByTable.get(reach.parent)
  if (!parent) throw new Error(`space teardown parent is not planned: ${reach.parent}`)
  return `${tuple(reach.columns)} IN (SELECT ${tuple(reach.parentColumns)} FROM ${identifier(reach.parent)} WHERE ${teardownPredicate(parent.table)})`
}
function teardownPredicate(table: string): string {
  const step = teardownByTable.get(table)
  if (!step) throw new Error(`space teardown table is not planned: ${table}`)
  return `(${step.reachedBy.map(reachPredicate).join(' OR ')})`
}

async function facts(tx: SQL, slug: string, userId: string) {
  await tx`SELECT set_config('app.user_id', ${userId}, true)`
  const spaces = await tx`
    SELECT s.id,s.metadata FROM space s
    JOIN membership m ON m.space_id=s.id
    WHERE s.slug=${slug} AND m.user_id=${userId}::uuid
    FOR UPDATE OF s
  `
  if (!spaces[0])
    return {
      spaceId: null,
      value: {
        exists: false,
        slug,
        marked: false,
        callerUserId: userId,
        members: [],
      } satisfies TrialDeleteFacts,
    }
  const spaceId = String(spaces[0].id)
  await bindTenant(tx, { userId, spaceId })
  const rows =
    await tx`SELECT m.user_id,u.email,m.role FROM membership m JOIN "user" u ON u.id=m.user_id WHERE m.space_id=${spaceId}::uuid ORDER BY u.email FOR UPDATE OF m`
  const members: TrialMemberFact[] = []
  for (const row of rows) {
    const checked =
      await tx`SELECT record_user_has_real_space_membership(${String(row.user_id)}::uuid) AS found`
    members.push({
      userId: String(row.user_id),
      email: String(row.email),
      role: String(row.role),
      hasRealSpace: checked[0]?.found === true,
    })
  }
  return {
    spaceId,
    value: {
      exists: true,
      slug,
      marked: isTrialSpaceMetadata(spaces[0].metadata),
      callerUserId: userId,
      members,
    } satisfies TrialDeleteFacts,
  }
}

export async function deleteTrialRecordSpace(input: {
  url: string
  slug: string
  userId: string
  activeSpaceId: string | null
}): Promise<TrialSpaceDeleteResult> {
  return recordPool(input.url).begin(async (tx) => {
    const read = await facts(tx, input.slug, input.userId)
    const decision = decideTrialSpaceDelete(read.value)
    if (!decision.allowed) throw new TrialSpaceDeleteError(decision.refusal)
    if (decision.nothing || !read.spaceId)
      return { nothingToRemove: true, activeSpaceCleared: false, tables: {}, neutralized: [] }
    const activeSpaceCleared = input.activeSpaceId === read.spaceId
    const neutralized: TrialSpaceDeleteResult['neutralized'] = []
    for (const member of decision.neutralize) {
      const sessions =
        await tx`DELETE FROM session WHERE user_id=${member.userId}::uuid RETURNING id`
      const keys =
        await tx`UPDATE machine_public_key SET revoked_at=COALESCE(revoked_at,now()) WHERE space_id=${read.spaceId}::uuid AND user_id=${member.userId}::uuid RETURNING key_id`
      neutralized.push({
        userId: member.userId,
        email: member.email,
        sessions: sessions.length,
        machineKeys: keys.length,
      })
    }
    const tables: Record<string, number> = {}
    // These rows precede every membership so membership_revoke_config_machines cannot strand a DEK.
    for (const step of SPACE_TEARDOWN_PLAN.filter((item) => item.table !== 'membership')) {
      const deleted = await tx.unsafe(
        `DELETE FROM ${identifier(step.table)} WHERE ${teardownPredicate(step.table)} RETURNING 1`,
        [read.spaceId],
      )
      tables[step.table] = deleted.length
    }
    const memberships =
      await tx`DELETE FROM membership WHERE space_id=${read.spaceId}::uuid RETURNING id`
    tables.membership = memberships.length
    const spaces = await tx`DELETE FROM space WHERE id=${read.spaceId}::uuid RETURNING id`
    tables.space = spaces.length
    return { nothingToRemove: false, activeSpaceCleared, tables, neutralized }
  })
}
