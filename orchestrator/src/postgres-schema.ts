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
import { PLATFORM_SLUG } from '../../shared/brand.ts'

/** Stable id and application-owned name for the platform tenant. */
export const PLATFORM_SPACE_ID = '01990000-0000-7000-8000-000000000001' as const
export const PLATFORM_OPERATOR_USER_ID = '01990000-0000-7000-8000-000000000002' as const
export const PLATFORM_SPACE_NAME = PLATFORM_SLUG

const identity = () => uuid('id').primaryKey()
export const spaceIdentity = () =>
  uuid('space_id')
    .notNull()
    .references(() => space.id)
export const tenantPolicies = (table: string, owner: AnyPgColumn) => {
  const ownsRow = sql`${owner} = nullif(current_setting('app.space_id', true), '')::uuid`
  return [
    pgPolicy(`${table}_space_select`, { for: 'select', using: ownsRow }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => tenantPolicies('space', table.id),
)

export const user = pgTable('user', {
  id: identity(),
  email: text().notNull().unique(),
  name: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const membership = pgTable.withRLS(
  'membership',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    role: text().notNull(),
    permission: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('membership_space_user_unique').on(table.spaceId, table.userId),
    ...tenantPolicies('membership', table.spaceId),
  ],
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
    }),
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
