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
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  CREDENTIAL_BINDINGS,
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_MODES,
  CREDENTIAL_PAYERS,
  CREDENTIAL_SLUG_SOURCE,
} from '../credential.ts'
import {
  project,
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
  spaceIdentity,
  tenantPolicies,
  user,
  writeMembershipPredicate,
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
  const mayWrite = writeMembershipPredicate(spaceId)
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
    pgPolicy('secret_dek_owner_select', {
      for: 'select',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
    }),
    pgPolicy('secret_dek_owner_delete', {
      for: 'delete',
      to: RECORD_OWNER_ROLE,
      using: sql`${table.spaceId} = nullif(current_setting('app.space_id', true), '')::uuid`,
    }),
  ],
)

export const configSecret = pgTable.withRLS(
  'config_secret',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    userId: uuid('user_id').references(() => user.id),
    projectId: uuid('project_id').references(() => project.id),
    key: text().notNull(),
    provider: text(),
    name: text(),
    type: text(),
    mode: text(),
    environment: text().notNull().default('default'),
    hint: text(),
    reachSpaceIds: uuid('reach_space_ids').array(),
    dekId: uuid('dek_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    envelope: bytea().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('config_secret_scope_unique')
      .on(table.spaceId, table.userId, table.projectId, table.key, table.environment)
      .nullsNotDistinct(),
    check(
      'config_secret_credential_fields_check',
      sql`(${table.provider} IS NULL AND ${table.name} IS NULL AND ${table.type} IS NULL AND ${table.hint} IS NULL AND ${table.projectId} IS NULL AND ${table.mode} IS NULL) OR
          (${table.provider} IS NOT NULL AND (${table.name} IS NULL OR ${table.name} ~ ${sql.raw(`'${CREDENTIAL_SLUG_SOURCE}'`)}) AND ${table.type} IS NOT NULL AND ${table.provider} ~ ${sql.raw(`'${CREDENTIAL_SLUG_SOURCE}'`)} AND ${table.type} ~ ${sql.raw(`'${CREDENTIAL_SLUG_SOURCE}'`)} AND ${table.hint} IS NOT NULL AND ${table.mode} IN ${sql.raw(`(${CREDENTIAL_MODES.map((value) => `'${value}'`).join(',')})`)} AND ${table.environment} IN ${sql.raw(`(${CREDENTIAL_ENVIRONMENTS.map((value) => `'${value}'`).join(',')})`)})`,
    ),
    check(
      'config_secret_credential_identity_key_check',
      sql`${table.provider} IS NULL OR (${table.mode} IS NOT NULL AND ${table.key} = ${table.provider} || '/' || CASE WHEN ${table.name} IS NULL THEN '' ELSE ${table.name} || '/' END || ${table.type} || '#' || ${table.mode} || '@' || ${table.environment})`,
    ),
    foreignKey({
      columns: [table.spaceId, table.dekId],
      foreignColumns: [secretDek.spaceId, secretDek.id],
      name: 'config_secret_space_dek_fk',
    }),
    ...actorPolicies('config_secret', table.spaceId, table.userId),
    pgPolicy('config_secret_owner_select', {
      for: 'select',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
    }),
  ],
)

export const credentialPayerPreference = pgTable.withRLS(
  'credential_payer_preference',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    projectId: uuid('project_id').references(() => project.id),
    provider: text().notNull(),
    name: text(),
    type: text().notNull(),
    mode: text().notNull().default('default'),
    environment: text().notNull().default('local'),
    preferredPayer: text('preferred_payer').notNull(),
    preferredBinding: text('preferred_binding').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('credential_payer_preference_identity_unique')
      .on(
        table.spaceId,
        table.userId,
        table.projectId,
        table.provider,
        table.name,
        table.type,
        table.mode,
        table.environment,
      )
      .nullsNotDistinct(),
    check(
      'credential_payer_preference_slug_check',
      sql`${table.provider} ~ ${sql.raw(`'${CREDENTIAL_SLUG_SOURCE}'`)} AND (${table.name} IS NULL OR ${table.name} ~ ${sql.raw(`'${CREDENTIAL_SLUG_SOURCE}'`)}) AND ${table.type} ~ ${sql.raw(`'${CREDENTIAL_SLUG_SOURCE}'`)}`,
    ),
    check(
      'credential_payer_preference_values_check',
      sql`${table.mode} IN ${sql.raw(`(${CREDENTIAL_MODES.map((value) => `'${value}'`).join(',')})`)} AND ${table.environment} IN ${sql.raw(`(${CREDENTIAL_ENVIRONMENTS.map((value) => `'${value}'`).join(',')})`)} AND ${table.preferredPayer} IN ${sql.raw(`(${CREDENTIAL_PAYERS.map((value) => `'${value}'`).join(',')})`)} AND ${table.preferredBinding} IN ${sql.raw(`(${CREDENTIAL_BINDINGS.map((value) => `'${value}'`).join(',')})`)}`,
    ),
    ...actorPolicies('credential_payer_preference', table.spaceId, table.userId),
    pgPolicy('credential_payer_preference_owner_select', {
      for: 'select',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
    }),
  ],
)

export const secretDekWrap = pgTable.withRLS(
  'secret_dek_wrap',
  {
    id: uuid('id').primaryKey(),
    spaceId: spaceIdentity(),
    dekId: uuid('dek_id').notNull(),
    recipientKeyId: text('recipient_key_id').notNull(),
    senderKeyId: text('sender_key_id').notNull(),
    enc: bytea().notNull(),
    ciphertext: bytea().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('secret_dek_wrap_space_dek_recipient_sender_unique').on(
      table.spaceId,
      table.dekId,
      table.recipientKeyId,
      table.senderKeyId,
    ),
    foreignKey({
      columns: [table.spaceId, table.dekId],
      foreignColumns: [secretDek.spaceId, secretDek.id],
      name: 'secret_dek_wrap_space_dek_fk',
    }),
    foreignKey({
      columns: [table.spaceId, table.recipientKeyId],
      foreignColumns: [machinePublicKey.spaceId, machinePublicKey.keyId],
      name: 'secret_dek_wrap_space_recipient_key_fk',
    }),
    foreignKey({
      columns: [table.spaceId, table.senderKeyId],
      foreignColumns: [machinePublicKey.spaceId, machinePublicKey.keyId],
      name: 'secret_dek_wrap_space_sender_key_fk',
    }),
    check('secret_dek_wrap_recipient_key_id_check', keyIdCheck(table.recipientKeyId)),
    check('secret_dek_wrap_sender_key_id_check', keyIdCheck(table.senderKeyId)),
    ...actorPolicies('secret_dek_wrap', table.spaceId),
    pgPolicy('secret_dek_wrap_owner_select', {
      for: 'select',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
    }),
    pgPolicy('secret_dek_wrap_owner_delete', {
      for: 'delete',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
    }),
  ],
)

export const machinePublicKey = pgTable.withRLS(
  'machine_public_key',
  {
    id: uuid('id').primaryKey(),
    spaceId: spaceIdentity(),
    userId: uuid('user_id').references(() => user.id),
    keyId: text('key_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    signingPublicKey: bytea('signing_public_key'),
    label: text().notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('machine_public_key_space_key_unique').on(table.spaceId, table.keyId),
    check('machine_public_key_key_id_check', keyIdCheck(table.keyId)),
    check('machine_public_key_length_check', sql`octet_length(${table.publicKey}) = 32`),
    check(
      'machine_public_key_signing_length_check',
      sql`${table.signingPublicKey} IS NULL OR octet_length(${table.signingPublicKey}) = 32`,
    ),
    ...tenantPolicies('machine_public_key', table.spaceId),
    pgPolicy('machine_public_key_owner_select', {
      for: 'select',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
    }),
    pgPolicy('machine_public_key_owner_update', {
      for: 'update',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
)

export const machineTrustLog = pgTable.withRLS(
  'machine_trust_log',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    seq: integer().notNull(),
    hash: bytea().notNull(),
    prevHash: bytea('prev_hash'),
    entry: bytea().notNull(),
    createdAt: createdAt(),
  },
  (table) => {
    const [selectPolicy, insertPolicy] = tenantPolicies('machine_trust_log', table.spaceId)
    return [
      unique('machine_trust_log_space_seq_unique').on(table.spaceId, table.seq),
      unique('machine_trust_log_space_hash_unique').on(table.spaceId, table.hash),
      check('machine_trust_log_hash_length_check', sql`octet_length(${table.hash}) = 32`),
      check(
        'machine_trust_log_prev_hash_check',
        sql`(${table.seq} = 0 AND ${table.prevHash} IS NULL) OR (${table.seq} > 0 AND ${table.prevHash} IS NOT NULL AND octet_length(${table.prevHash}) = 32)`,
      ),
      selectPolicy!,
      insertPolicy!,
      pgPolicy('machine_trust_log_owner_select', {
        for: 'select',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
      pgPolicy('machine_trust_log_owner_delete', {
        for: 'delete',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
    ]
  },
)

export const machineJoinNameplate = pgTable.withRLS(
  'machine_join_nameplate',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    nameplate: text().notNull(),
    allocatedBy: uuid('allocated_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failedBy: uuid('failed_by').references(() => user.id),
  },
  (table) => {
    const [selectPolicy, insertPolicy, updatePolicy] = tenantPolicies(
      'machine_join_nameplate',
      table.spaceId,
    )
    return [
      unique('machine_join_nameplate_space_nameplate_unique').on(table.spaceId, table.nameplate),
      check(
        'machine_join_nameplate_nameplate_check',
        sql`${table.nameplate} ~ '^[1-9][0-9]{0,5}$'`,
      ),
      selectPolicy!,
      insertPolicy!,
      updatePolicy!,
      pgPolicy('machine_join_nameplate_owner_select', {
        for: 'select',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
      pgPolicy('machine_join_nameplate_owner_delete', {
        for: 'delete',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
    ]
  },
)

export const machineJoinMessage = pgTable.withRLS(
  'machine_join_message',
  {
    id: identity(),
    nameplateId: uuid('nameplate_id')
      .notNull()
      .references(() => machineJoinNameplate.id, { onDelete: 'cascade' }),
    spaceId: spaceIdentity(),
    side: text().notNull(),
    phase: text().notNull(),
    body: bytea().notNull(),
    postedBy: uuid('posted_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (table) => {
    const [selectPolicy, insertPolicy] = tenantPolicies('machine_join_message', table.spaceId)
    return [
      unique('machine_join_message_nameplate_side_phase_unique').on(
        table.nameplateId,
        table.side,
        table.phase,
      ),
      check('machine_join_message_side_check', sql`${table.side} ~ '^[0-9a-f]{32}$'`),
      check('machine_join_message_phase_check', sql`${table.phase} ~ '^[a-z0-9-]{1,32}$'`),
      check('machine_join_message_body_check', sql`octet_length(${table.body}) BETWEEN 1 AND 4096`),
      selectPolicy!,
      insertPolicy!,
      pgPolicy('machine_join_message_owner_select', {
        for: 'select',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
      pgPolicy('machine_join_message_owner_delete', {
        for: 'delete',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
    ]
  },
)

export const machineKeyClaimChallenge = pgTable.withRLS(
  'machine_key_claim_challenge',
  {
    id: uuid('id').primaryKey(),
    spaceId: spaceIdentity(),
    keyId: text('key_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    nonceHash: bytea('nonce_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.spaceId, table.keyId],
      foreignColumns: [machinePublicKey.spaceId, machinePublicKey.keyId],
      name: 'machine_key_claim_challenge_space_key_fk',
    }),
    check('machine_key_claim_challenge_key_id_check', keyIdCheck(table.keyId)),
    check(
      'machine_key_claim_challenge_hash_length_check',
      sql`octet_length(${table.nonceHash}) = 32`,
    ),
    ...tenantPolicies('machine_key_claim_challenge', table.spaceId),
    pgPolicy('machine_key_claim_challenge_owner_delete', {
      for: 'delete',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
    }),
  ],
)
