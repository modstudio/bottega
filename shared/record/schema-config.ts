// concern: postgres-schema-config
/** Hosted config metadata and ciphertext-only secret storage. */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bytea,
  check,
  foreignKey,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  RECORD_ACTOR_ROLE,
  RECORD_READER_ROLE,
  spaceIdentity,
  tenantPolicies,
  user,
} from './schema.ts'

const identity = () => uuid('id').primaryKey()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull()
const currentSpace = sql`nullif(current_setting('app.space_id', true), '')::uuid`
const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`
const keyIdCheck = (column: AnyPgColumn) =>
  sql`length(${column}) = 22 AND ${column} ~ '^[A-Za-z0-9_-]{22}$'`

function actorPolicies(table: string, spaceId: AnyPgColumn, userId?: AnyPgColumn) {
  const ownsSpace = sql`${spaceId} = ${currentSpace}`
  const ownsUser = userId ? sql`${userId} IS NULL OR ${userId} = ${currentUser}` : sql`true`
  const mayWrite = sql`EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = ${spaceId} AND m.user_id = ${currentUser} AND m.permission = 'write'
  )`
  const readsRow = sql`(${ownsSpace}) AND (${ownsUser})`
  const writesRow = sql`(${ownsSpace}) AND (${ownsUser}) AND (${mayWrite})`

  return [
    pgPolicy(`${table}_actor_select`, {
      for: 'select',
      to: RECORD_ACTOR_ROLE,
      using: readsRow,
    }),
    pgPolicy(`${table}_actor_insert`, {
      for: 'insert',
      to: RECORD_ACTOR_ROLE,
      withCheck: writesRow,
    }),
    pgPolicy(`${table}_actor_update`, {
      for: 'update',
      to: RECORD_ACTOR_ROLE,
      using: writesRow,
      withCheck: writesRow,
    }),
    pgPolicy(`${table}_actor_delete`, {
      for: 'delete',
      to: RECORD_ACTOR_ROLE,
      using: writesRow,
    }),
    pgPolicy(`${table}_reader_backstop`, {
      as: 'restrictive',
      for: 'select',
      to: RECORD_READER_ROLE,
      using: sql`false`,
    }),
  ]
}

export const configEntry = pgTable.withRLS(
  'config_entry',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    userId: uuid('user_id').references(() => user.id),
    key: text().notNull(),
    environment: text().notNull().default('default'),
    value: text().notNull(),
    rowVersion: integer('row_version').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('config_entry_scope_unique')
      .on(table.spaceId, table.userId, table.key, table.environment)
      .nullsNotDistinct(),
    ...tenantPolicies('config_entry', table.spaceId),
    pgPolicy('config_entry_user_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${table.userId} IS NULL OR ${table.userId} = ${currentUser}`,
      withCheck: sql`${table.userId} IS NULL OR ${table.userId} = ${currentUser}`,
    }),
  ],
)

export const secretDek = pgTable.withRLS(
  'secret_dek',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    version: integer().notNull(),
    createdAt: createdAt(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    unique('secret_dek_space_version_unique').on(table.spaceId, table.version),
    unique('secret_dek_space_id_unique').on(table.spaceId, table.id),
    ...actorPolicies('secret_dek', table.spaceId),
  ],
)

export const configSecret = pgTable.withRLS(
  'config_secret',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    userId: uuid('user_id').references(() => user.id),
    key: text().notNull(),
    environment: text().notNull().default('default'),
    dekId: uuid('dek_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    envelope: bytea().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('config_secret_scope_unique')
      .on(table.spaceId, table.userId, table.key, table.environment)
      .nullsNotDistinct(),
    foreignKey({
      columns: [table.spaceId, table.dekId],
      foreignColumns: [secretDek.spaceId, secretDek.id],
      name: 'config_secret_space_dek_fk',
    }),
    ...actorPolicies('config_secret', table.spaceId, table.userId),
  ],
)

export const secretDekWrap = pgTable.withRLS(
  'secret_dek_wrap',
  {
    spaceId: spaceIdentity(),
    dekId: uuid('dek_id').notNull(),
    recipientKeyId: text('recipient_key_id').notNull(),
    senderKeyId: text('sender_key_id').notNull(),
    enc: bytea().notNull(),
    ciphertext: bytea().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.spaceId, table.dekId, table.recipientKeyId, table.senderKeyId],
    }),
    foreignKey({
      columns: [table.spaceId, table.dekId],
      foreignColumns: [secretDek.spaceId, secretDek.id],
      name: 'secret_dek_wrap_space_dek_fk',
    }),
    check('secret_dek_wrap_recipient_key_id_check', keyIdCheck(table.recipientKeyId)),
    check('secret_dek_wrap_sender_key_id_check', keyIdCheck(table.senderKeyId)),
    ...actorPolicies('secret_dek_wrap', table.spaceId),
  ],
)

export const machinePublicKey = pgTable.withRLS(
  'machine_public_key',
  {
    spaceId: spaceIdentity(),
    keyId: text('key_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    label: text().notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('machine_public_key_space_key_unique').on(table.spaceId, table.keyId),
    check('machine_public_key_key_id_check', keyIdCheck(table.keyId)),
    check('machine_public_key_length_check', sql`octet_length(${table.publicKey}) = 32`),
    ...tenantPolicies('machine_public_key', table.spaceId),
  ],
)
