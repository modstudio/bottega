// concern: postgres-schema-auth
/** Better Auth-owned record tables. Must not know local execution state or run phases. */
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { space, spaceIdentity, tenantPolicies, user } from './postgres-schema.ts'

const identity = () => uuid('id').primaryKey()

export const session = pgTable(
  'session',
  {
    id: identity(),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    activeSpaceId: uuid('active_space_id').references(() => space.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
)

export const account = pgTable(
  'account',
  {
    id: identity(),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text(),
    idToken: text('id_token'),
    password: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
)

export const verification = pgTable('verification', {
  id: identity(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const invitation = pgTable.withRLS(
  'invitation',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    email: text().notNull(),
    inviterId: uuid('inviter_id').notNull().references(() => user.id),
    role: text(),
    status: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('invitation_space_id_idx').on(table.spaceId),
    index('invitation_email_idx').on(table.email),
    ...tenantPolicies('invitation', table.spaceId),
  ],
)
