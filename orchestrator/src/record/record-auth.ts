// concern: record-auth
/** Owns record identity, bearer sessions, and personal-space repair. Must not know run phases. */

import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { APIError, betterAuth } from 'better-auth'
import { bearer, organization } from 'better-auth/plugins'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { membership, newRecordId, space, user } from '../../../shared/record/schema.ts'
import { account, invitation, session, verification } from '../../../shared/record/schema-auth.ts'
import { sendPasswordResetEmail } from '../mail/password-reset-mailer.ts'

export const RECORD_SESSION_KEY = 'record_session'
export const RECORD_SIGN_IN_REMEDY =
  'record session is missing or expired; run `orch record sign-in --email <email>`'
export const RECORD_SIGN_UP_INVITATION_REQUIRED =
  'Record sign-up is by invitation only; ask a record space owner to run `orch record space invite --email <email>`.'

type RecordAuthEnvironment = Record<string, string | undefined>

export function recordAllowedOrigins(environment: RecordAuthEnvironment = process.env): string[] {
  const configured = environment.RECORD_API_ALLOWED_ORIGINS
  if (configured === undefined) return []
  const origins = configured.split(',').map((value) => value.trim())
  if (origins.some((value) => !value))
    throw new Error('RECORD_API_ALLOWED_ORIGINS must contain comma-separated origins')
  for (const origin of origins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error(`RECORD_API_ALLOWED_ORIGINS contains an invalid origin: ${origin}`)
    }
    if (parsed.origin !== origin)
      throw new Error(`RECORD_API_ALLOWED_ORIGINS contains an invalid origin: ${origin}`)
  }
  return origins
}

export type PersonalSpace = { id: string; name: string; slug: string }
export type PersonalSpacePort = {
  find(userId: string): Promise<PersonalSpace | null>
  create(input: PersonalSpace & { userId: string; membershipId: string }): Promise<PersonalSpace>
}

export type SessionSpaceFacts = {
  rememberedSpaceId: string | null
  personalSpaceId: string
  membershipSpaceIds: string[]
}

/** Memberships are ordered oldest first by the adapter. */
export function sessionSpace(facts: SessionSpaceFacts): string {
  if (facts.rememberedSpaceId && facts.membershipSpaceIds.includes(facts.rememberedSpaceId))
    return facts.rememberedSpaceId
  return (
    facts.membershipSpaceIds.find((spaceId) => spaceId !== facts.personalSpaceId) ??
    facts.personalSpaceId
  )
}

/** The same decision runs after signup and before every session, making interrupted provisioning repairable. */
export async function ensurePersonalSpace(
  userId: string,
  port: PersonalSpacePort,
): Promise<PersonalSpace> {
  const existing = await port.find(userId)
  if (existing) return existing
  return port.create({
    id: newRecordId(),
    userId,
    membershipId: newRecordId(),
    name: userId,
    slug: `user-${userId}`,
  })
}

function personalSpacePort(client: SQL): PersonalSpacePort {
  return {
    async find(userId) {
      return client.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${userId}, true)`
        const rows = await tx`
          SELECT s.id, s.name, s.slug
          FROM "user" u
          LEFT JOIN space s ON s.id=u.personal_space_id
          LEFT JOIN membership m ON m.space_id=s.id AND m.user_id=u.id
          WHERE u.id=${userId}::uuid
            AND m.id IS NOT NULL
        `
        const row = rows[0]
        return row?.id
          ? { id: String(row.id), name: String(row.name), slug: String(row.slug) }
          : null
      })
    },
    async create(input) {
      return client.begin(async (tx) => {
        const users = await tx`
          SELECT name, personal_space_id FROM "user" WHERE id=${input.userId}::uuid FOR UPDATE
        `
        const owner = users[0]
        if (!owner) throw new Error(`record user is absent: ${input.userId}`)
        if (owner.personal_space_id) {
          await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
          await tx`SELECT set_config('app.space_id', ${String(owner.personal_space_id)}, true)`
          const existing = await tx`
            SELECT id, name, slug FROM space WHERE id=${String(owner.personal_space_id)}::uuid
          `
          if (existing[0]) {
            await tx`
              INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
              VALUES (${input.membershipId}::uuid, ${String(owner.personal_space_id)}::uuid,
                ${input.userId}::uuid, 'owner', 'write', now())
              ON CONFLICT (space_id,user_id) DO UPDATE SET role='owner', permission='write'
            `
            return {
              id: String(existing[0].id),
              name: String(existing[0].name),
              slug: String(existing[0].slug),
            }
          }
        }
        await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
        await tx`SELECT set_config('app.space_id', ${input.id}, true)`
        await tx`
          INSERT INTO space (id,name,slug,created_at)
          VALUES (${input.id}::uuid, ${String(owner.name)}, ${input.slug}, now())
        `
        await tx`
          INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
          VALUES (${input.membershipId}::uuid, ${input.id}::uuid, ${input.userId}::uuid, 'owner', 'write', now())
        `
        await tx`
          UPDATE "user" SET personal_space_id=${input.id}::uuid, updated_at=now()
          WHERE id=${input.userId}::uuid
        `
        return { id: input.id, name: String(owner.name), slug: input.slug }
      })
    },
  }
}

async function sessionSpaceForUser(client: SQL, userId: string, personalSpaceId: string) {
  return client.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`
    const users = await tx`
      SELECT last_active_space_id FROM "user" WHERE id=${userId}::uuid
    `
    const memberships = await tx`
      SELECT space_id FROM membership WHERE user_id=${userId}::uuid
      ORDER BY created_at, id
    `
    return sessionSpace({
      rememberedSpaceId: users[0]?.last_active_space_id
        ? String(users[0].last_active_space_id)
        : null,
      personalSpaceId,
      membershipSpaceIds: memberships.map((row: Record<string, unknown>) => String(row.space_id)),
    })
  })
}

type ResetPasswordSender = typeof sendPasswordResetEmail

export function recordAuth(
  url: string,
  environment: RecordAuthEnvironment = process.env,
  sendReset: ResetPasswordSender = sendPasswordResetEmail,
) {
  const secret = environment.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required for record authentication')
  const trustedOrigins = recordAllowedOrigins(environment)
  const cookieDomain = environment.RECORD_AUTH_COOKIE_DOMAIN
  const hubUrl = environment.RECORD_HUB_URL
  // Auth instances are short-lived at the CLI boundary; a one-connection pool keeps repeated
  // commands from reserving the database's entire connection budget before garbage collection.
  const client = new SQL(url, { max: 1 })
  const personalSpaces = personalSpacePort(client)
  const invitationOnlySignUp = Object.assign(
    async (input: unknown) => {
      const context = input as { path?: string; body?: Record<string, unknown> }
      if (context.path !== '/sign-up/email') return
      const candidateEmail =
        typeof context.body?.email === 'string' ? context.body.email.trim().toLowerCase() : ''
      const rows = await client`
        SELECT public.invitation_open_for(${candidateEmail}) AS invited
      `
      if (rows[0]?.invited !== true) {
        throw APIError.from('FORBIDDEN', {
          code: 'SIGN_UP_REQUIRES_INVITATION',
          message: RECORD_SIGN_UP_INVITATION_REQUIRED,
        })
      }
    },
    { options: {} },
  )
  return betterAuth({
    secret,
    ...(trustedOrigins.length ? { trustedOrigins } : {}),
    database: drizzleAdapter(drizzle({ client }), {
      provider: 'pg',
      schema: { user, session, account, verification, space, membership, invitation },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      sendResetPassword: async ({ user: resetUser, token }) => {
        if (!hubUrl)
          throw new Error(
            'RECORD_HUB_URL is required for password reset links; set it to the hosted hub origin',
          )
        const resetUrl = new URL('/reset-password', hubUrl)
        resetUrl.searchParams.set('token', token)
        await sendReset({ to: resetUser.email, resetUrl: resetUrl.href }, environment)
      },
    },
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      customRules: { '/request-password-reset': { window: 60 * 60, max: 5 } },
    },
    hooks: { before: invitationOnlySignUp },
    user: { modelName: 'user' },
    session: { modelName: 'session' },
    account: { modelName: 'account' },
    verification: { modelName: 'verification' },
    advanced: {
      database: { generateId: () => newRecordId() },
      ...(cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain }, useSecureCookies: true }
        : {}),
      ipAddress: { ipAddressHeaders: ['fly-client-ip'] },
    },
    plugins: [
      organization({
        schema: {
          organization: { modelName: 'space' },
          member: {
            modelName: 'membership',
            fields: { organizationId: 'spaceId' },
            additionalFields: {
              permission: { type: 'string', required: true, defaultValue: 'write' },
            },
          },
          invitation: { modelName: 'invitation', fields: { organizationId: 'spaceId' } },
          session: { fields: { activeOrganizationId: 'activeSpaceId' } },
        },
      }),
      bearer(),
    ],
    databaseHooks: {
      user: {
        create: {
          // Better Auth documents no personal-organization convention; the record repairs it here.
          after: async (created) => {
            await ensurePersonalSpace(created.id, personalSpaces)
          },
        },
      },
      session: {
        create: {
          before: async (created) => {
            const personal = await ensurePersonalSpace(created.userId, personalSpaces)
            const activeSpaceId = await sessionSpaceForUser(client, created.userId, personal.id)
            return { data: { ...created, activeOrganizationId: activeSpaceId } }
          },
        },
      },
    },
  })
}

export type RecordIdentity = {
  user: Record<string, unknown> & { id: string }
  activeSpaceId: string | null
  personalSpaceId: string | null
  memberships: Record<string, unknown>[]
}

export function activeMembershipSpace(
  activeSpaceId: string | null,
  membershipSpaceIds: readonly string[],
): string | null {
  return activeSpaceId && membershipSpaceIds.includes(activeSpaceId) ? activeSpaceId : null
}

export function recordIdentityFromRows(
  user: Record<string, unknown> & { id: string },
  activeSpaceId: string | null,
  personalSpaceId: string | null,
  memberships: Record<string, unknown>[],
): RecordIdentity {
  return {
    user,
    activeSpaceId: activeMembershipSpace(
      activeSpaceId,
      memberships.map((row) => String(row.space_id)),
    ),
    personalSpaceId,
    memberships,
  }
}

export async function recordIdentity(
  url: string,
  user: Record<string, unknown> & { id: string },
  activeSpaceId: string | null,
): Promise<RecordIdentity> {
  const sql = new SQL(url)
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${user.id}, true)`
      await tx`SELECT set_config('app.space_id', ${activeSpaceId ?? ''}, true)`
      const users = await tx`SELECT personal_space_id FROM "user" WHERE id=${user.id}::uuid`
      const personalSpaceId = users[0]?.personal_space_id
        ? String(users[0].personal_space_id)
        : null
      const memberships = await tx`
        SELECT s.id AS space_id, s.name, s.slug, m.role, m.permission
        FROM membership m JOIN space s ON s.id=m.space_id
        WHERE m.user_id=${user.id}::uuid ORDER BY s.slug
      `
      return recordIdentityFromRows(user, activeSpaceId, personalSpaceId, [...memberships])
    })
  } finally {
    await sql.close()
  }
}

export const bearerHeaders = (token: string) => new Headers({ Authorization: `Bearer ${token}` })

export async function setActiveRecordSpace(
  url: string,
  token: string,
  spaceId: string,
): Promise<void> {
  return setActiveRecordSpaceForSession(url, bearerHeaders(token), spaceId)
}

export async function setActiveRecordSpaceForSession(
  url: string,
  headers: Headers,
  spaceId: string,
): Promise<void> {
  const auth = recordAuth(url)
  const current = await auth.api.getSession({ headers })
  if (!current) throw new Error(RECORD_SIGN_IN_REMEDY)
  const sql = new SQL(url)
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
      await tx`SELECT set_config('app.space_id', ${spaceId}, true)`
      const memberships = await tx`
        SELECT 1 FROM membership WHERE user_id=${current.user.id}::uuid AND space_id=${spaceId}::uuid
      `
      if (memberships.length !== 1)
        throw new Error(`record user is not a member of space ${spaceId}`)
      await tx`
        UPDATE session SET active_space_id=${spaceId}::uuid, updated_at=now()
        WHERE id=${current.session.id}::uuid
      `
      await tx`
        UPDATE "user" SET last_active_space_id=${spaceId}::uuid, updated_at=now()
        WHERE id=${current.user.id}::uuid
      `
    })
  } finally {
    await sql.close()
  }
}
