// concern: postgres-schema-space-agents
/** Hosted agent declarations shared within one record space. */
import { boolean, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { spaceIdentity, tenantPolicies } from './schema.ts'

export const spaceAgent = pgTable.withRLS(
  'space_agent',
  {
    id: uuid('id').primaryKey(),
    spaceId: spaceIdentity(),
    name: text().notNull(),
    harness: text().notNull(),
    backend: text(),
    model: text().notNull(),
    baseUrl: text('base_url'),
    transport: text().notNull(),
    provider: text(),
    apiKeySecret: text('api_key_secret'),
    requestSettings: jsonb('request_settings'),
    jobs: jsonb(),
    preferredJobs: jsonb('preferred_jobs'),
    maxConcurrent: integer('max_concurrent'),
    routeMetered: boolean('route_metered').notNull(),
    trainsOnInputs: boolean('trains_on_inputs').notNull(),
    operatedBy: text('operated_by').notNull(),
    billing: text().notNull(),
  },
  (table) => [
    unique('space_agent_space_name_unique').on(table.spaceId, table.name),
    ...tenantPolicies('space_agent', table.spaceId),
  ],
)
