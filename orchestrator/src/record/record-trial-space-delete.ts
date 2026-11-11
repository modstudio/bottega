// concern: record-trial-space-delete
/** Guards and atomically tears down trial or confirmed general spaces without deleting users. */
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import {
  buildRecordTeardownPredicates,
  SPACE_TEARDOWN_PLAN,
} from './record-space-teardown-plan.ts'
import { isTrialSpaceMetadata, TRIAL_IDENTIFIER_PREFIX } from './record-trial-space.ts'
import {
  SpaceDeleteError,
  type SpaceDeleteResult,
} from './record-trial-space-contract.ts'

type TrialMemberFact = { userId: string; email: string; role: string; hasRealSpace: boolean }
export type SpaceDeleteFacts = {
  exists: boolean
  slug: string
  marked: boolean
  publiclyListed: boolean
  callerUserId: string
  members: TrialMemberFact[]
}
export type SpaceDeleteDecision =
  | { allowed: true; nothing: boolean; neutralize: TrialMemberFact[] }
  | { allowed: false; refusal: string }
const retry = `choose a space created with \`${PLATFORM_SLUG} record space create --trial\``
type CommonSpaceDeleteGuard =
  | { kind: 'public-listing' }
  | { kind: 'caller-owner' }
  | { kind: 'trial-member-email' | 'trial-member-spaces'; member: TrialMemberFact }
function commonSpaceDeleteGuard(
  facts: SpaceDeleteFacts,
): CommonSpaceDeleteGuard | null {
  if (facts.publiclyListed) return { kind: 'public-listing' }
  if (facts.members.find((member) => member.userId === facts.callerUserId)?.role !== 'owner')
    return { kind: 'caller-owner' }
  for (const member of facts.members) {
    if (member.userId === facts.callerUserId) continue
    if (!member.email.startsWith(TRIAL_IDENTIFIER_PREFIX))
      return { kind: 'trial-member-email', member }
    if (member.hasRealSpace)
      return { kind: 'trial-member-spaces', member }
  }
  return null
}
function renderTrialGuard(facts: SpaceDeleteFacts, guard: CommonSpaceDeleteGuard): string {
  if (guard.kind === 'public-listing')
    return `public-listing guard failed: trial space ${facts.slug} is publicly listed in public_doc_space; ask record_owner to remove that row, then retry`
  if (guard.kind === 'caller-owner')
    return `caller-owner guard failed: ask an owner of ${facts.slug} to run delete-trial`
  if (guard.kind === 'trial-member-email')
    return `trial-member-email guard failed: ${guard.member.email} is not a trial account; remove that member, then retry`
  return `trial-member-spaces guard failed: ${guard.member.email} belongs to a non-trial space; remove that member, then retry`
}
export function decideTrialSpaceDelete(facts: SpaceDeleteFacts): SpaceDeleteDecision {
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
  const guard = commonSpaceDeleteGuard(facts)
  if (guard) return { allowed: false, refusal: renderTrialGuard(facts, guard) }
  return {
    allowed: true,
    nothing: false,
    neutralize: facts.members.filter((member) => member.userId !== facts.callerUserId),
  }
}

export type ConfirmedSpaceDeleteFacts = SpaceDeleteFacts & {
  confirmation: string
  personalSpace: boolean
}
export function decideSpaceDelete(facts: ConfirmedSpaceDeleteFacts): SpaceDeleteDecision {
  if (!facts.exists) return { allowed: true, nothing: true, neutralize: [] }
  if (facts.confirmation !== facts.slug)
    return {
      allowed: false,
      refusal: `confirmation guard failed: --confirm must equal ${facts.slug}; run \`${PLATFORM_SLUG} record space delete ${facts.slug} --confirm ${facts.slug}\``,
    }
  if (facts.personalSpace)
    return {
      allowed: false,
      refusal: `personal-space guard failed: ${facts.slug} is a user's personal space; choose a non-personal space to delete`,
    }
  const guard = commonSpaceDeleteGuard(facts)
  if (guard) {
    if (guard.kind === 'public-listing')
      return {
        allowed: false,
        refusal: `public-listing guard failed: space ${facts.slug} is publicly listed in public_doc_space; ask record_owner to remove that row, then retry`,
      }
    if (guard.kind === 'caller-owner')
      return {
        allowed: false,
        refusal: `caller-owner guard failed: ask an owner of ${facts.slug} to run \`${PLATFORM_SLUG} record space delete ${facts.slug} --confirm ${facts.slug}\``,
      }
    return {
      allowed: false,
      refusal: `${guard.member.email} holds a real account in ${facts.slug}; space delete removes only the owner and trial accounts, and member removal is not yet available from the CLI, so this space cannot be deleted while that member remains`,
    }
  }
  return {
    allowed: true,
    nothing: false,
    neutralize: facts.members.filter((member) => member.userId !== facts.callerUserId),
  }
}
const teardownSql = buildRecordTeardownPredicates(SPACE_TEARDOWN_PLAN, 'space', 'id=$1')

async function facts(tx: SQL, slug: string, userId: string) {
  await tx`SELECT set_config('app.user_id', ${userId}, true)`
  const spaces = await tx`
    SELECT s.id FROM space s
    JOIN membership m ON m.space_id=s.id
    WHERE s.slug=${slug} AND m.user_id=${userId}::uuid
  `
  if (!spaces[0])
    return {
      spaceId: null,
      value: {
        exists: false,
        slug,
        marked: false,
        publiclyListed: false,
        callerUserId: userId,
        members: [],
      } satisfies SpaceDeleteFacts,
    }
  const spaceId = String(spaces[0].id)
  await bindTenant(tx, { userId, spaceId })
  const locked = await tx`SELECT metadata FROM space WHERE id=${spaceId}::uuid FOR UPDATE`
  if (!locked[0])
    return {
      spaceId: null,
      value: {
        exists: false,
        slug,
        marked: false,
        publiclyListed: false,
        callerUserId: userId,
        members: [],
      } satisfies SpaceDeleteFacts,
    }
  const publicRows =
    await tx`SELECT 1 FROM public_doc_space WHERE space_id=${spaceId}::uuid LIMIT 1`
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
    personalSpace:
      (await tx`SELECT 1 FROM "user" WHERE personal_space_id=${spaceId}::uuid LIMIT 1`).length > 0,
    value: {
      exists: true,
      slug,
      marked: isTrialSpaceMetadata(locked[0].metadata),
      publiclyListed: publicRows.length > 0,
      callerUserId: userId,
      members,
    } satisfies SpaceDeleteFacts,
  }
}

export async function deleteTrialRecordSpace(input: {
  url: string
  slug: string
  userId: string
  activeSpaceId: string | null
}): Promise<SpaceDeleteResult> {
  return deleteRecordSpaceTransaction(input, 'trial')
}

export async function deleteRecordSpace(input: {
  url: string
  slug: string
  confirmation: string
  userId: string
  activeSpaceId: string | null
}): Promise<SpaceDeleteResult> {
  return deleteRecordSpaceTransaction(input, 'general')
}

async function deleteRecordSpaceTransaction(
  input: {
    url: string
    slug: string
    confirmation?: string
    userId: string
    activeSpaceId: string | null
  },
  mode: 'trial' | 'general',
): Promise<SpaceDeleteResult> {
  return recordPool(input.url).begin(async (tx) => {
    const read = await facts(tx, input.slug, input.userId)
    const decision =
      mode === 'trial'
        ? decideTrialSpaceDelete(read.value)
        : decideSpaceDelete({
            ...read.value,
            confirmation: input.confirmation ?? '',
            personalSpace: read.personalSpace ?? false,
          })
    if (!decision.allowed) throw new SpaceDeleteError(decision.refusal)
    if (decision.nothing || !read.spaceId)
      return { nothingToRemove: true, activeSpaceCleared: false, tables: {}, neutralized: [] }
    const activeSpaceCleared = input.activeSpaceId === read.spaceId
    const neutralized: SpaceDeleteResult['neutralized'] = []
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
        `DELETE FROM ${teardownSql.identifier(step.table)} WHERE ${teardownSql.predicate(step.table)} RETURNING 1`,
        [read.spaceId],
      )
      tables[step.table] = deleted.length
    }
    const protectedRows =
      mode === 'trial'
        ? await tx`SELECT * FROM record_delete_trial_protected_space_rows(${read.spaceId}::uuid)`
        : await tx`SELECT * FROM record_delete_protected_space_rows(${read.spaceId}::uuid)`
    tables.secret_dek = Number(protectedRows[0]?.secret_dek_count ?? 0)
    tables.routing_evidence_head = Number(protectedRows[0]?.routing_evidence_head_count ?? 0)
    const memberships =
      await tx`DELETE FROM membership WHERE space_id=${read.spaceId}::uuid RETURNING id`
    tables.membership = memberships.length
    const spaces = await tx`DELETE FROM space WHERE id=${read.spaceId}::uuid RETURNING id`
    tables.space = spaces.length
    return { nothingToRemove: false, activeSpaceCleared, tables, neutralized }
  })
}
