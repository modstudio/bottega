// concern: record-space-teardown-plan
/** Derives child-before-parent space teardown and project purge plans from the hosted schema. */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import * as root from '../../../shared/record/schema.ts'
import * as a from '../../../shared/record/schema-auth.ts'
import * as b from '../../../shared/record/schema-board.ts'
import * as c from '../../../shared/record/schema-config.ts'
import * as d from '../../../shared/record/schema-docs.ts'
import * as h from '../../../shared/record/schema-hub.ts'
import * as la from '../../../shared/record/schema-landing.ts'
import * as lc from '../../../shared/record/schema-lens-catalogue.ts'
import * as p from '../../../shared/record/schema-port.ts'
import * as q from '../../../shared/record/schema-question.ts'
import * as rc from '../../../shared/record/schema-record-change.ts'
import * as rel from '../../../shared/record/schema-release.ts'
import * as rev from '../../../shared/record/schema-review.ts'
import * as r from '../../../shared/record/schema-run.ts'
import * as sn from '../../../shared/record/schema-snapshots.ts'
import * as su from '../../../shared/record/schema-subjects.ts'
import * as tf from '../../../shared/record/schema-task-flow.ts'
import * as w from '../../../shared/record/schema-workflow-catalogue.ts'

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
type ForeignKeyFact = {
  table: string
  columns: string[]
  parent: string
  parentColumns: string[]
  onDelete?: string
}
export type RecordTeardownReach = {
  columns: string[]
  parent: string
  parentColumns: string[]
}
export type RecordTeardownStep = { table: string; reachedBy: RecordTeardownReach[] }
export const SPACE_TEARDOWN_EXCLUSIONS = {
  public_doc_space:
    'a published space is refused before teardown and record_actor holds SELECT only',
  record_change: 'ON DELETE CASCADE removes change-feed rows with the space',
  routing_evidence_head: 'deleted by the trial teardown definer function; actor DELETE is revoked',
  session: 'session.active_space_id is ON DELETE SET NULL',
  secret_dek: 'deleted by the trial teardown definer function; actor DELETE is revoked',
  user: 'personal_space_id and last_active_space_id are ON DELETE SET NULL',
} as const
export const PROJECT_PURGE_EXCLUSIONS = {
  public_doc_space:
    'purge refuses a publicly listed project, so no row can remain, and record_actor holds no DELETE on the table by design',
} as const

function foreignKeyFacts(tables: readonly PgTable[] = hostedRecordTables): ForeignKeyFact[] {
  return tables.flatMap((item) =>
    getTableConfig(item).foreignKeys.map((key) => {
      const reference = key.reference()
      return {
        table: getTableConfig(item).name,
        columns: reference.columns.map((column) => column.name),
        parent: getTableConfig(reference.foreignTable).name,
        parentColumns: reference.foreignColumns.map((column) => column.name),
        onDelete: key.onDelete,
      }
    }),
  )
}

const blocksParentDelete = (fact: ForeignKeyFact) =>
  fact.onDelete !== 'cascade' && fact.onDelete !== 'set null'
const belongsToPurgedProject = (fact: ForeignKeyFact) => fact.onDelete !== 'cascade'

function discoverReachedTables(
  facts: readonly ForeignKeyFact[],
  tableNames: readonly string[],
  exclusions: Readonly<Record<string, string>>,
  rootTable: string,
  follows: (fact: ForeignKeyFact) => boolean,
): Map<string, RecordTeardownReach[]> {
  const reached = new Set<string>()
  const remaining = new Set(tableNames)
  let parents = new Set([rootTable])
  while (parents.size) {
    const added = new Set<string>()
    for (const name of remaining) {
      if (exclusions[name]) continue
      const reaches = facts.filter(
        (fact) => fact.table === name && parents.has(fact.parent) && follows(fact),
      )
      if (!reaches.length) continue
      reached.add(name)
      added.add(name)
    }
    for (const name of added) remaining.delete(name)
    parents = added
  }
  return new Map(
    [...reached].map((name) => [
      name,
      facts
        .filter(
          (fact) =>
            fact.table === name &&
            fact.table !== fact.parent &&
            (fact.parent === rootTable || reached.has(fact.parent)) &&
            follows(fact),
        )
        .map(({ columns, parent, parentColumns }) => ({ columns, parent, parentColumns })),
    ]),
  )
}

function orderReachedTables(
  facts: readonly ForeignKeyFact[],
  reachedBy: ReadonlyMap<string, RecordTeardownReach[]>,
  follows: (fact: ForeignKeyFact) => boolean,
  cycleName: string,
): RecordTeardownStep[] {
  const pending = new Set(reachedBy.keys())
  const dependencies = new Map([...pending].map((name) => [name, new Set<string>()]))
  for (const fact of facts)
    if (
      fact.table !== fact.parent &&
      pending.has(fact.table) &&
      pending.has(fact.parent) &&
      follows(fact)
    )
      dependencies.get(fact.table)?.add(fact.parent)

  const plan: RecordTeardownStep[] = []
  while (pending.size) {
    const ready = [...pending]
      .filter(
        (name) =>
          ![...pending].some((child) => child !== name && dependencies.get(child)?.has(name)),
      )
      .sort()
    if (!ready.length)
      throw new Error(`${cycleName} dependency cycle: ${[...pending].sort().join(', ')}`)
    for (const name of ready) {
      plan.push({ table: name, reachedBy: reachedBy.get(name)! })
      pending.delete(name)
    }
  }
  return plan
}

export function deriveSpaceTeardownPlan(
  tables: readonly PgTable[] = hostedRecordTables,
  exclusions: Readonly<Record<string, string>> = SPACE_TEARDOWN_EXCLUSIONS,
): RecordTeardownStep[] {
  const facts = foreignKeyFacts(tables)
  const names = tables.map((item) => getTableConfig(item).name)
  return orderReachedTables(
    facts,
    discoverReachedTables(facts, names, exclusions, 'space', blocksParentDelete),
    blocksParentDelete,
    'space teardown',
  )
}

export const SPACE_TEARDOWN_PLAN = deriveSpaceTeardownPlan()
export const SPACE_TEARDOWN_ORDER = SPACE_TEARDOWN_PLAN.map((step) => step.table)

export function deriveProjectPurgePlan(
  tables: readonly PgTable[] = hostedRecordTables,
  exclusions: Readonly<Record<string, string>> = PROJECT_PURGE_EXCLUSIONS,
): RecordTeardownStep[] {
  const facts = foreignKeyFacts(tables)
  const names = tables.map((item) => getTableConfig(item).name)
  return orderReachedTables(
    facts,
    discoverReachedTables(facts, names, exclusions, 'project', belongsToPurgedProject),
    belongsToPurgedProject,
    'project purge',
  )
}

export const PROJECT_PURGE_PLAN = deriveProjectPurgePlan()
export const PROJECT_PURGE_ORDER = PROJECT_PURGE_PLAN.map((step) => step.table)

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const tuple = (columns: readonly string[]) =>
  columns.length === 1 ? identifier(columns[0]!) : `(${columns.map(identifier).join(',')})`
const selectList = (columns: readonly string[]) => columns.map(identifier).join(',')

/** Builds one recursive row predicate for every step in a derived teardown plan. */
export function buildRecordTeardownPredicates(
  plan: readonly RecordTeardownStep[],
  rootTable: string,
  rootPredicate: string,
): { identifier(value: string): string; predicate(table: string): string } {
  const steps = new Map(plan.map((step) => [step.table, step]))
  const reachPredicate = (reach: RecordTeardownReach): string => {
    if (reach.parent === rootTable)
      return `${tuple(reach.columns)} IN (SELECT ${selectList(reach.parentColumns)} FROM ${identifier(rootTable)} WHERE ${rootPredicate})`
    if (!steps.has(reach.parent))
      throw new Error(`${rootTable} teardown parent is not planned: ${reach.parent}`)
    return `${tuple(reach.columns)} IN (SELECT ${selectList(reach.parentColumns)} FROM ${identifier(reach.parent)} WHERE ${predicate(reach.parent)})`
  }
  const predicate = (table: string): string => {
    const step = steps.get(table)
    if (!step) throw new Error(`${rootTable} teardown table is not planned: ${table}`)
    return `(${step.reachedBy.map(reachPredicate).join(' OR ')})`
  }
  return { identifier, predicate }
}

function unclassifiedTeardownTables(
  rootTable: string,
  follows: (fact: ForeignKeyFact) => boolean,
  tables: readonly PgTable[] = hostedRecordTables,
  order: readonly string[],
  exclusions: Readonly<Record<string, string>>,
): string[] {
  const classified = new Set(order)
  return [
    ...new Set(
      foreignKeyFacts(tables)
        .filter(
          (fact) =>
            follows(fact) &&
            (fact.parent === rootTable || classified.has(fact.parent)) &&
            !classified.has(fact.table) &&
            !exclusions[fact.table],
        )
        .map((fact) => fact.table),
    ),
  ].sort()
}

export function unclassifiedSpaceTables(
  tables: readonly PgTable[] = hostedRecordTables,
  order: readonly string[] = SPACE_TEARDOWN_ORDER,
  exclusions: Readonly<Record<string, string>> = SPACE_TEARDOWN_EXCLUSIONS,
): string[] {
  return unclassifiedTeardownTables('space', blocksParentDelete, tables, order, exclusions)
}

export function unclassifiedProjectTables(
  tables: readonly PgTable[] = hostedRecordTables,
  order: readonly string[] = PROJECT_PURGE_ORDER,
  exclusions: Readonly<Record<string, string>> = PROJECT_PURGE_EXCLUSIONS,
): string[] {
  return unclassifiedTeardownTables(
    'project',
    belongsToPurgedProject,
    tables,
    order,
    exclusions,
  )
}
