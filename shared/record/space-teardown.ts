// concern: hosted-space-teardown-shape
/** Derives the child-before-parent delete order from the hosted Drizzle schema. */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import * as root from './schema.ts'
import * as a from './schema-auth.ts'
import * as b from './schema-board.ts'
import * as c from './schema-config.ts'
import * as d from './schema-docs.ts'
import * as h from './schema-hub.ts'
import * as la from './schema-landing.ts'
import * as lc from './schema-lens-catalogue.ts'
import * as p from './schema-port.ts'
import * as q from './schema-question.ts'
import * as rc from './schema-record-change.ts'
import * as rel from './schema-release.ts'
import * as rev from './schema-review.ts'
import * as r from './schema-run.ts'
import * as sn from './schema-snapshots.ts'
import * as su from './schema-subjects.ts'
import * as tf from './schema-task-flow.ts'
import * as w from './schema-workflow-catalogue.ts'

const modules = [root, a, r, q, tf, rev, rel, la, d, su, h, sn, c, b, w, lc, p, rc]
const table = (value: unknown): value is PgTable => {
  try {
    return Boolean(getTableConfig(value as PgTable).name)
  } catch {
    return false
  }
}
const hostedRecordTables = [
  ...new Set(modules.flatMap((module) => Object.values(module)).filter(table)),
]
export type SpaceForeignKeyFact = { table: string; columns: string[]; onDelete?: string }
export const SPACE_TEARDOWN_EXCLUSIONS = {
  record_change: 'ON DELETE CASCADE removes change-feed rows with the space',
  session: 'session.active_space_id is ON DELETE SET NULL',
  user: 'personal_space_id and last_active_space_id are ON DELETE SET NULL',
} as const

export function spaceForeignKeyFacts(
  tables: readonly PgTable[] = hostedRecordTables,
): SpaceForeignKeyFact[] {
  return tables.flatMap((item) =>
    getTableConfig(item).foreignKeys.flatMap((key) => {
      const reference = key.reference()
      return getTableConfig(reference.foreignTable).name === 'space'
        ? [
            {
              table: getTableConfig(item).name,
              columns: reference.columns.map((column) => column.name),
              onDelete: key.onDelete,
            },
          ]
        : []
    }),
  )
}

function deriveSpaceTeardownOrder(tables: readonly PgTable[] = hostedRecordTables): string[] {
  const byName = new Map(tables.map((item) => [getTableConfig(item).name, item]))
  const remaining = new Set(
    spaceForeignKeyFacts(tables)
      .map((fact) => fact.table)
      .filter((name) => !(name in SPACE_TEARDOWN_EXCLUSIONS)),
  )
  const parents = new Map([...remaining].map((name) => [name, new Set<string>()]))
  for (const child of remaining)
    for (const key of getTableConfig(byName.get(child)!).foreignKeys) {
      const parent = getTableConfig(key.reference().foreignTable).name
      if (remaining.has(parent) && key.onDelete !== 'cascade') parents.get(child)?.add(parent)
    }
  const order: string[] = []
  while (remaining.size) {
    const ready = [...remaining]
      .filter(
        (name) => ![...remaining].some((child) => child !== name && parents.get(child)?.has(name)),
      )
      .sort()
    if (!ready.length)
      throw new Error(`space teardown dependency cycle: ${[...remaining].sort().join(', ')}`)
    for (const name of ready) {
      order.push(name)
      remaining.delete(name)
    }
  }
  return order
}
export const SPACE_TEARDOWN_ORDER = deriveSpaceTeardownOrder()
export function unclassifiedSpaceTables(
  facts: readonly SpaceForeignKeyFact[],
  order: readonly string[] = SPACE_TEARDOWN_ORDER,
  exclusions: Readonly<Record<string, string>> = SPACE_TEARDOWN_EXCLUSIONS,
): string[] {
  return [...new Set(facts.map((fact) => fact.table))]
    .filter((name) => !order.includes(name) && !exclusions[name])
    .sort()
}
