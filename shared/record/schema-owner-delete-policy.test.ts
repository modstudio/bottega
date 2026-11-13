import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is } from 'drizzle-orm'
import { getTableConfig, PgDialect, type PgPolicy, PgTable } from 'drizzle-orm/pg-core'
import drizzleConfig from './drizzle.config.ts'
import { RECORD_OWNER_ROLE } from './schema.ts'

const policyTargetsRole = (target: unknown): boolean =>
  Array.isArray(target)
    ? target.some(policyTargetsRole)
    : target === RECORD_OWNER_ROLE ||
      (typeof target === 'object' &&
        target !== null &&
        'name' in target &&
        target.name === RECORD_OWNER_ROLE)

const dialect = new PgDialect()
const isUnconditionalOwnerPolicy = (policy: PgPolicy): boolean =>
  policyTargetsRole(policy.to) &&
  policy.using !== undefined &&
  dialect.sqlToQuery(policy.using).sql.trim() === 'true'

test('unconditional owner deletes used by prunes have unconditional owner selects', async () => {
  const paths = Array.isArray(drizzleConfig.schema) ? drizzleConfig.schema : [drizzleConfig.schema]
  const modules = await Promise.all(
    paths.map((path) => import(pathToFileURL(resolve(import.meta.dir, '../..', path!)).href)),
  )
  const missing = modules
    .flatMap((module) => Object.values(module).filter((value) => is(value, PgTable)))
    .map(getTableConfig)
    .filter((table) => {
      return (
        table.policies.some(
          (policy) => policy.for === 'delete' && isUnconditionalOwnerPolicy(policy),
        ) &&
        !table.policies.some(
          (policy) => policy.for === 'select' && isUnconditionalOwnerPolicy(policy),
        )
      )
    })
    .map((table) => table.name)
    .sort()

  expect(missing).toEqual([])
})
