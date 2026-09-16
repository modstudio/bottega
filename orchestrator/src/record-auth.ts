// concern: record-auth
/** Owns record identity, bearer sessions, and personal-space repair. Must not know run phases. */

import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { betterAuth } from 'better-auth'
import { bearer, organization } from 'better-auth/plugins'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { membership, newRecordId, space, user } from './postgres-schema.ts'
import { account, invitation, session, verification } from './postgres-schema-auth.ts'

export const RECORD_SESSION_KEY = 'record_session'
export const RECORD_SIGN_IN_REMEDY =
  'record session is missing or expired; run `orch record sign-in --email <email>`'

export type PersonalSpace = { id: string; name: string; slug: string }
export type PersonalSpacePort = {
  find(userId: string): Promise<PersonalSpace | null>
  create(input: PersonalSpace & { userId: string; membershipId: string }): Promise<PersonalSpace>
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

export function recordAuth(url: string) {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required for record authentication')
  // Auth instances are short-lived at the CLI boundary; a one-connection pool keeps repeated
  // commands from reserving the database's entire connection budget before garbage collection.
  const client = new SQL(url, { max: 1 })
  const personalSpaces = personalSpacePort(client)
  return betterAuth({
    secret,
    database: drizzleAdapter(drizzle({ client }), {
      provider: 'pg',
      schema: { user, session, account, verification, space, membership, invitation },
    }),
    emailAndPassword: { enabled: true },
    user: { modelName: 'user' },
    session: { modelName: 'session' },
    account: { modelName: 'account' },
    verification: { modelName: 'verification' },
    advanced: { database: { generateId: () => newRecordId() } },
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
            return { data: { ...created, activeOrganizationId: personal.id } }
          },
        },
      },
    },
  })
}

export type RecordIdentity = {
  user: Record<string, unknown> & { id: string }
  activeSpaceId: string | null
  memberships: Record<string, unknown>[]
}

export async function recordIdentity(
  url: string,
  user: Record<string, unknown> & { id: string },
  activeSpaceId: string | null,
): Promise<RecordIdentity> {
  if (!activeSpaceId) return { user, activeSpaceId, memberships: [] }
  const sql = new SQL(url)
  try {
    const memberships = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${user.id}, true)`
      await tx`SELECT set_config('app.space_id', ${activeSpaceId}, true)`
      return tx`
        SELECT s.id AS space_id, s.name, s.slug, m.role, m.permission
        FROM membership m JOIN space s ON s.id=m.space_id
        WHERE m.user_id=${user.id}::uuid ORDER BY s.slug
      `
    })
    return { user, activeSpaceId, memberships: [...memberships] }
  } finally {
    await sql.close()
  }
}

export const bearerHeaders = (token: string) => new Headers({ Authorization: `Bearer ${token}` })
