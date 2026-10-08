import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  foreignKey,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
/** Stable id and application-owned name for the platform tenant. */
export const PLATFORM_SPACE_ID = '01990000-0000-7000-8000-000000000001' as const
export const RECORD_OWNER_ROLE = 'record_owner' as const
export const RECORD_AUTH_ROLE = 'record_auth' as const
export const RECORD_ACTOR_ROLE = 'record_actor' as const
export const RECORD_PUBLIC_ROLE = 'record_public' as const
export const RECORD_READER_ROLE = 'record_reader' as const

const identity = () => uuid('id').primaryKey()
export const spaceIdentity = () =>
  uuid('space_id')
    .notNull()
    .references(() => space.id)
export const tenantPolicies = (table: string, owner: AnyPgColumn) => {
  const ownsRow = sql`${owner} = nullif(current_setting('app.space_id', true), '')::uuid`
  const readsRow = sql`${ownsRow} OR ${owner} = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  )`
  return [
    pgPolicy(`${table}_space_select`, { for: 'select', using: readsRow }),
    pgPolicy(`${table}_space_insert`, { for: 'insert', withCheck: ownsRow }),
    pgPolicy(`${table}_space_update`, { for: 'update', using: ownsRow, withCheck: ownsRow }),
    pgPolicy(`${table}_space_delete`, { for: 'delete', using: ownsRow }),
  ]
}

export const space = pgTable.withRLS(
  'space',
  {
    id: identity(),
    name: text().notNull().unique(),
    slug: text().notNull().unique(),
    logo: text(),
    metadata: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => {
    const currentSpace = sql`nullif(current_setting('app.space_id', true), '')::uuid`
    const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`
    return [
      pgPolicy('space_space_select', {
        for: 'select',
        using: sql`${table.id} = ${currentSpace} OR EXISTS (
          SELECT 1 FROM membership m WHERE m.space_id = ${table.id} AND m.user_id = ${currentUser}
        )`,
      }),
      pgPolicy('space_space_insert', {
        for: 'insert',
        withCheck: sql`${table.id} = ${currentSpace}`,
      }),
      pgPolicy('space_space_update', {
        for: 'update',
        using: sql`${table.id} = ${currentSpace}`,
        withCheck: sql`${table.id} = ${currentSpace}`,
      }),
      pgPolicy('space_space_delete', { for: 'delete', using: sql`${table.id} = ${currentSpace}` }),
      pgPolicy('space_auth_all', {
        for: 'all',
        to: RECORD_AUTH_ROLE,
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ]
  },
)

export const user = pgTable('user', {
  id: identity(),
  email: text().notNull().unique(),
  name: text().notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text(),
  personalSpaceId: uuid('personal_space_id').references(() => space.id, { onDelete: 'set null' }),
  lastActiveSpaceId: uuid('last_active_space_id').references(() => space.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const inviteePolicies = (table: string, email: AnyPgColumn) => {
  const ownsInvitation = sql`lower(${email}) = (
    SELECT lower(u.email) FROM "user" u
    WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
  )`
  return [
    pgPolicy(`${table}_invitee_select`, { for: 'select', using: ownsInvitation }),
    pgPolicy(`${table}_invitee_update`, {
      for: 'update',
      using: ownsInvitation,
      withCheck: ownsInvitation,
    }),
  ]
}

export const membership = pgTable.withRLS(
  'membership',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    role: text().notNull(),
    permission: text().notNull().default('write'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => {
    const currentSpace = sql`nullif(current_setting('app.space_id', true), '')::uuid`
    const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`
    return [
      unique('membership_space_user_unique').on(table.spaceId, table.userId),
      pgPolicy('membership_space_select', {
        for: 'select',
        using: sql`${table.spaceId} = ${currentSpace} OR ${table.userId} = ${currentUser}`,
      }),
      pgPolicy('membership_space_insert', {
        for: 'insert',
        withCheck: sql`${table.spaceId} = ${currentSpace}`,
      }),
      pgPolicy('membership_space_update', {
        for: 'update',
        using: sql`${table.spaceId} = ${currentSpace}`,
        withCheck: sql`${table.spaceId} = ${currentSpace}`,
      }),
      pgPolicy('membership_space_delete', {
        for: 'delete',
        using: sql`${table.spaceId} = ${currentSpace}`,
      }),
      pgPolicy('membership_auth_all', {
        for: 'all',
        to: RECORD_AUTH_ROLE,
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ]
  },
)

export const machine = pgTable('machine', {
  id: identity(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id),
  name: text().notNull(),
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull(),
})

export const project = pgTable.withRLS(
  'project',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    name: text().notNull(),
    keyPrefixes: text('key_prefixes').array().notNull().default(sql`ARRAY[]::text[]`),
    checkoutPath: text('checkout_path'),
    stack: text(),
    canon: boolean().notNull().default(true),
    managedContext: boolean('managed_context').notNull().default(false),
    landingBranch: text('landing_branch'),
    productionBranch: text('production_branch'),
    gate: text(),
    requireCleanMain: boolean('require_clean_main').notNull().default(true),
    color: text(),
    colorDark: text('color_dark'),
    envPrefix: text('env_prefix'),
    mcpServer: text('mcp_server'),
    workerMcpServers: text('worker_mcp_servers').array(),
    secretPaths: text('secret_paths').array(),
    mcpProbeTool: text('mcp_probe_tool'),
    docs: jsonb(),
    signals: jsonb(),
    release: jsonb(),
    states: jsonb(),
    tracker: jsonb(),
    worktree: jsonb(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('project_space_name_unique').on(table.spaceId, table.name),
    unique('project_space_id_unique').on(table.spaceId, table.id),
    ...tenantPolicies('project', table.spaceId),
  ],
)

export const seq = pgTable.withRLS(
  'seq',
  {
    spaceId: spaceIdentity(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id),
    name: text().notNull(),
    next: bigint({ mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.projectId, table.name] }),
    foreignKey({
      columns: [table.spaceId, table.projectId],
      foreignColumns: [project.spaceId, project.id],
      name: 'seq_space_project_fk',
    }).onUpdate('cascade'),
    ...tenantPolicies('seq', table.spaceId),
  ],
)

/** IDs are minted before a database connection exists; no id column has a default. */
let lastRecordId = ''

export function newRecordId(): string {
  let candidate = Bun.randomUUIDv7()
  while (candidate <= lastRecordId) candidate = Bun.randomUUIDv7()
  lastRecordId = candidate
  return candidate
}
