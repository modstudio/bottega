import type { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is } from 'drizzle-orm'
import { type AnyPgTable, getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import drizzleConfig from '../shared/record/drizzle.config.ts'

export type KeyStore = 'orchestrator' | 'hub' | 'hosted'
type KeyColumn = {
  table: string
  name: string
  type: string
  required: boolean
  primaryKey: boolean
  foreignKey: boolean
  foreignTargets: { table: string; column: string }[]
}
export type KeyTable = { name: string; columns: KeyColumn[]; primaryKey: string[] }
export type ManifestColumn = { store: KeyStore; column: string; reason: string }
export type DisplayLabel = ManifestColumn & { sibling: string }
export type InfrastructureIdentity = { store: KeyStore; table: string; reason: string }
type SyncedSource = {
  store: Exclude<KeyStore, 'hosted'>
  kind: 'read' | 'write' | 'snapshot'
  sources: readonly string[]
  reason: string
}
export type SyncedSources = Readonly<Record<string, SyncedSource>>
export type KeyInventory = { findings: string[]; values: string[]; infrastructure: string[] }
export type KeyManifests = {
  values: readonly ManifestColumn[]
  displayLabels: readonly DisplayLabel[]
  references: readonly ManifestColumn[]
  externalIdentifiers: readonly ManifestColumn[]
  uuids: readonly ManifestColumn[]
  infrastructure: readonly InfrastructureIdentity[]
  syncedSources: SyncedSources
}

export type SyncedSchemaFact = {
  store: Exclude<KeyStore, 'hosted'>
  table: string
  foreignTables: readonly string[]
}

type StoreManifests = {
  values: Map<string, string>
  displayLabels: Map<string, DisplayLabel>
  references: Map<string, string>
  externalIdentifiers: Map<string, string>
  uuids: Map<string, string>
  infrastructure: Map<string, string>
}

const REFERENCE_NAME = /(?:^parent_|_(?:id|ids|ref|key|session)$)/
const PROJECT_NAME = /^(?:project|repo|.*_project)$/

export function classifyKeyInventory(
  store: KeyStore,
  tables: readonly KeyTable[],
  allManifests: KeyManifests,
): KeyInventory {
  const manifests = keyManifests(store, allManifests)
  validateDisplayLabels(store, tables, manifests)
  const seen = {
    values: new Set<string>(),
    references: new Set<string>(),
    externalIdentifiers: new Set<string>(),
    uuids: new Set<string>(),
  }
  const findings = tables.flatMap((table) => classifyKeyTable(store, table, manifests, seen))
  validateKeyManifests(store, tables, manifests, seen)
  return {
    findings: [...new Set(findings)].sort(),
    values: [...seen.values].sort(),
    infrastructure: [...manifests.infrastructure.keys()].sort(),
  }
}

function keyManifests(store: KeyStore, manifests: KeyManifests): StoreManifests {
  const selected = (entries: readonly ManifestColumn[]) =>
    new Map(
      entries.filter((entry) => entry.store === store).map((entry) => [entry.column, entry.reason]),
    )
  return {
    values: selected(manifests.values),
    displayLabels: new Map(
      manifests.displayLabels
        .filter((entry) => entry.store === store)
        .map((entry) => [entry.column, entry]),
    ),
    references: selected(manifests.references),
    externalIdentifiers: selected(manifests.externalIdentifiers),
    uuids: selected(manifests.uuids),
    infrastructure: new Map(
      manifests.infrastructure
        .filter((entry) => entry.store === store)
        .map((entry) => [entry.table, entry.reason]),
    ),
  }
}

function classifyKeyTable(
  store: KeyStore,
  table: KeyTable,
  manifests: StoreManifests,
  seen: {
    values: Set<string>
    references: Set<string>
    externalIdentifiers: Set<string>
    uuids: Set<string>
  },
): string[] {
  const findings = hasOwnedUuidPrimaryKey(table, manifests.uuids)
    ? []
    : [`${table.name}:primary-key`]
  if (store === 'orchestrator' && !manifests.infrastructure.has(table.name)) {
    const requiredUuid = table.columns.some(
      (column) => column.required && manifests.uuids.has(`${table.name}.${column.name}`),
    )
    if (!requiredUuid) findings.push(`${table.name}:required-uuid`)
  }
  for (const column of table.columns)
    findings.push(...classifyKeyColumn(store, column, manifests, seen))
  return findings
}

function hasOwnedUuidPrimaryKey(table: KeyTable, uuids: ReadonlyMap<string, string>): boolean {
  if (table.primaryKey.length !== 1) return false
  const primaryColumn = table.columns.find((column) => column.name === table.primaryKey[0])
  return Boolean(
    primaryColumn &&
      (primaryColumn.type === 'uuid' || uuids.has(`${table.name}.${primaryColumn.name}`)) &&
      !primaryColumn.foreignKey,
  )
}

function classifyKeyColumn(
  store: KeyStore,
  column: KeyColumn,
  manifests: StoreManifests,
  seen: {
    values: Set<string>
    references: Set<string>
    externalIdentifiers: Set<string>
    uuids: Set<string>
  },
): string[] {
  const address = `${column.table}.${column.name}`
  const uuid = column.type === 'uuid' || manifests.uuids.has(address)
  if (uuid) seen.uuids.add(address)
  const externalIdentifier = manifests.externalIdentifiers.has(address)
  if (externalIdentifier) seen.externalIdentifiers.add(address)
  const explicitReference = manifests.references.has(address)
  if (explicitReference) seen.references.add(address)
  const displayLabel = manifests.displayLabels.has(address)
  const shapedReference =
    (column.type === 'integer' || column.type === 'text') && REFERENCE_NAME.test(column.name)
  const shapedProjectName =
    store === 'orchestrator' && column.type === 'text' && PROJECT_NAME.test(column.name)
  if (
    !column.foreignKey &&
    (column.type === 'integer' || column.type === 'text') &&
    (shapedReference || shapedProjectName) &&
    !uuid &&
    !externalIdentifier &&
    !explicitReference &&
    !displayLabel &&
    !manifests.values.has(address)
  )
    throw new Error(`${store} reference-shaped column ${address} is not classified`)
  const reference =
    !displayLabel &&
    (column.foreignKey || (!externalIdentifier && shapedReference) || explicitReference)
  if (manifests.values.has(address)) seen.values.add(address)
  if (column.type === 'integer')
    classifyIntegerColumn(
      store,
      address,
      column,
      reference || displayLabel,
      manifests.values,
      seen.values,
    )
  return reference && !uuid ? [`${address}:reference`] : []
}

function classifyIntegerColumn(
  store: KeyStore,
  address: string,
  column: KeyColumn,
  reference: boolean,
  values: ReadonlyMap<string, string>,
  seenValues: Set<string>,
): void {
  const reason = values.get(address)
  if (!reason) {
    if (!column.primaryKey && !reference)
      throw new Error(
        `${store} integer column ${address} is not classified as a value or row identity`,
      )
    return
  }
  if (column.primaryKey || column.foreignKey)
    throw new Error(`${store} integer value ${address} may not be a primary or foreign key`)
  if (reference) throw new Error(`${store} integer value ${address} is shaped as a row reference`)
  if (!reason.trim()) throw new Error(`${store} integer value ${address} needs a reason`)
  seenValues.add(address)
}

function validateKeyManifests(
  store: KeyStore,
  tables: readonly KeyTable[],
  manifests: StoreManifests,
  seen: {
    values: ReadonlySet<string>
    references: ReadonlySet<string>
    externalIdentifiers: ReadonlySet<string>
    uuids: ReadonlySet<string>
  },
): void {
  const columns = new Map(
    tables.flatMap((table) =>
      table.columns.map((column) => [`${table.name}.${column.name}`, column] as const),
    ),
  )
  const kinds = [
    ['value', manifests.values],
    ['display label', manifests.displayLabels],
    ['reference', manifests.references],
    ['external identifier', manifests.externalIdentifiers],
    ['UUID', manifests.uuids],
  ] as const
  for (let left = 0; left < kinds.length; left++) {
    for (let right = left + 1; right < kinds.length; right++) {
      const overlap = [...kinds[left]![1].keys()].filter((column) => kinds[right]![1].has(column))
      if (overlap.length)
        throw new Error(
          `${store} ${kinds[left]![0]}/${kinds[right]![0]} manifests overlap: ${overlap.join(', ')}`,
        )
    }
  }
  validateManifestEntries(store, 'integer value', manifests.values, seen.values)
  validateManifestEntries(store, 'undeclared reference', manifests.references, seen.references)
  validateManifestEntries(
    store,
    'external identifier',
    manifests.externalIdentifiers,
    seen.externalIdentifiers,
  )
  validateManifestEntries(store, 'UUID column', manifests.uuids, seen.uuids)
  validateManifestShapes(store, columns, manifests)
  validateInfrastructure(
    store,
    new Set(tables.map((table) => table.name)),
    manifests.infrastructure,
  )
}

function validateDisplayLabels(
  store: KeyStore,
  tables: readonly KeyTable[],
  manifests: StoreManifests,
): void {
  const columns = new Map(
    tables.flatMap((table) =>
      table.columns.map((column) => [`${table.name}.${column.name}`, column] as const),
    ),
  )
  for (const entry of manifests.displayLabels.values())
    validateDisplayLabel(store, entry, tables, columns, manifests)
}

function validateDisplayLabel(
  store: KeyStore,
  entry: DisplayLabel,
  tables: readonly KeyTable[],
  columns: ReadonlyMap<string, KeyColumn>,
  manifests: StoreManifests,
): void {
  const name = `${store} display label ${entry.column}`
  const table = entry.column.slice(0, entry.column.lastIndexOf('.'))
  if (!entry.reason.trim())
    throw new Error(`${name} needs a reason; remedy: provide a non-empty reason`)
  if (!columns.has(entry.column))
    throw new Error(`${name} is stale; remedy: name a column that exists in the store schema`)
  if (!entry.sibling.startsWith(`${table}.`))
    throw new Error(
      `${name} sibling ${entry.sibling} is on another table; remedy: name a sibling on ${table}`,
    )
  const sibling = columns.get(entry.sibling)
  if (!sibling)
    throw new Error(
      `${name} sibling ${entry.sibling} does not exist; remedy: name an existing sibling column`,
    )
  if (!isUuidReference(entry.sibling, sibling, tables, columns, manifests.uuids))
    throw new Error(
      `${name} sibling ${entry.sibling} is not a UUID reference; remedy: name a UUID column or a foreign key to a UUID primary key`,
    )
}

function isUuidReference(
  address: string,
  column: KeyColumn,
  tables: readonly KeyTable[],
  columns: ReadonlyMap<string, KeyColumn>,
  uuids: ReadonlyMap<string, string>,
): boolean {
  if (column.type === 'uuid') return true
  if (uuids.has(address)) return true
  return column.foreignTargets.some((target) => {
    const foreignTable = tables.find(({ name }) => name === target.table)
    if (foreignTable?.primaryKey.length !== 1 || foreignTable.primaryKey[0] !== target.column)
      return false
    const primaryKey = columns.get(`${foreignTable.name}.${foreignTable.primaryKey[0]}`)
    return Boolean(
      primaryKey &&
        (primaryKey.type === 'uuid' || uuids.has(`${primaryKey.table}.${primaryKey.name}`)),
    )
  })
}

function validateManifestEntries(
  store: KeyStore,
  kind: string,
  entries: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
): void {
  for (const [column, reason] of entries) {
    if (!reason.trim()) throw new Error(`${store} ${kind} ${column} needs a reason`)
    if (!seen.has(column)) throw new Error(`${store} ${kind} ${column} is stale`)
  }
}

function validateManifestShapes(
  store: KeyStore,
  columns: ReadonlyMap<string, KeyColumn>,
  manifests: StoreManifests,
): void {
  for (const column of manifests.uuids.keys()) {
    if (columns.get(column)?.type !== 'text')
      throw new Error(`${store} UUID column ${column} must be stored as TEXT`)
  }
  for (const column of manifests.references.keys()) {
    if (columns.get(column)?.foreignKey)
      throw new Error(`${store} undeclared reference ${column} is already a declared foreign key`)
  }
}

function validateInfrastructure(
  store: KeyStore,
  tableNames: ReadonlySet<string>,
  infrastructure: ReadonlyMap<string, string>,
): void {
  for (const [table, reason] of infrastructure) {
    if (!reason.trim()) throw new Error(`${store} infrastructure ${table} needs a reason`)
    if (!tableNames.has(table)) throw new Error(`${store} infrastructure ${table} is stale`)
  }
}

export function assertShrinkingKeyBaseline(
  store: KeyStore,
  findings: readonly string[],
  candidateBaseline: readonly string[],
  baseBaseline: readonly string[] | null,
): void {
  const actual = new Set(findings)
  const expected = new Set(candidateBaseline)
  const added = [...actual].filter((finding) => !expected.has(finding)).sort()
  const stale = [...expected].filter((finding) => !actual.has(finding)).sort()
  if (added.length)
    throw new Error(`${store} identity baseline has new findings: ${added.join(', ')}`)
  if (stale.length)
    throw new Error(
      `${store} identity baseline entries disappeared; remove them: ${stale.join(', ')}`,
    )
  if (baseBaseline) {
    const base = new Set(baseBaseline)
    const baselineGrowth = [...expected].filter((finding) => !base.has(finding)).sort()
    if (baselineGrowth.length)
      throw new Error(
        `${store} identity baseline may only shrink; candidate added: ${baselineGrowth.join(', ')}`,
      )
  }
}

export function syncedSourceRefusals(
  declarations: SyncedSources,
  methodInventory: readonly string[],
  exemptions: readonly InfrastructureIdentity[],
  schemaFacts: readonly SyncedSchemaFact[],
): string[] {
  const infrastructure = new Set(exemptions.map(({ store, table }) => `${store}.${table}`))
  const schemas = new Map(schemaFacts.map((fact) => [`${fact.store}.${fact.table}`, fact]))
  const missing = methodInventory.flatMap((method) =>
    declarations[method]
      ? []
      : [
          `${method}: synced source declaration is missing; remedy: declare it with its source tables`,
        ],
  )
  const methods = new Set(methodInventory)
  const stale = Object.keys(declarations).flatMap((method) =>
    methods.has(method)
      ? []
      : [`${method}: synced source declaration is stale; remedy: remove the stale declaration`],
  )
  const declared = Object.entries(declarations).flatMap(([method, declaration]) =>
    syncedDeclarationRefusals(method, declaration, infrastructure, schemas),
  )
  return [...new Set([...missing, ...stale, ...declared])].sort()
}

function syncedDeclarationRefusals(
  method: string,
  declaration: SyncedSource,
  infrastructure: ReadonlySet<string>,
  schemas: ReadonlyMap<string, SyncedSchemaFact>,
): string[] {
  if (declaration.kind === 'read') return []
  const empty =
    declaration.sources.length === 0 &&
    !/\b(?:no local table|built from)\b/i.test(declaration.reason)
      ? [
          `${method}: an empty synced source declaration needs a reason saying what it is built from; remedy: declare it with its source tables`,
        ]
      : []
  return [
    ...empty,
    ...declaration.sources.flatMap((table) =>
      syncedTableRefusals(method, declaration.store, table, infrastructure, schemas),
    ),
  ]
}

function syncedTableRefusals(
  method: string,
  store: 'orchestrator' | 'hub',
  table: string,
  infrastructure: ReadonlySet<string>,
  schemas: ReadonlyMap<string, SyncedSchemaFact>,
): string[] {
  const address = `${store}.${table}`
  const local = infrastructure.has(address)
    ? [
        `${method}: synced source ${address} is machine-local infrastructure; remedy: give the table a UUID primary key, or stop syncing it`,
      ]
    : []
  const schema = schemas.get(address)
  if (!schema)
    return [
      ...local,
      `${method}: synced source ${address} does not exist in the migrated schema; remedy: declare an existing source table`,
    ]
  return [
    ...local,
    ...schema.foreignTables.flatMap((foreignTable) =>
      infrastructure.has(`${store}.${foreignTable}`)
        ? [
            `${method}: synced source ${address} has a foreign key into machine-local infrastructure ${foreignTable}; remedy: give the table a UUID primary key, or stop syncing it`,
          ]
        : [],
    ),
  ]
}

export function sqliteSyncedSchemaFacts(
  store: 'orchestrator' | 'hub',
  tables: readonly KeyTable[],
): SyncedSchemaFact[] {
  return tables.map((table) => ({
    store,
    table: table.name,
    foreignTables: [
      ...new Set(
        table.columns.flatMap((column) => column.foreignTargets.map((target) => target.table)),
      ),
    ].sort(),
  }))
}

export function readSqliteKeyTables(database: Database): KeyTable[] {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
  return tables.map(({ name }) => {
    const columns = database
      .query<{ name: string; type: string; notnull: number; pk: number }, []>(
        `PRAGMA table_info('${name}')`,
      )
      .all()
    const foreignKeys = database
      .query<{ from: string; table: string; to: string }, []>(`PRAGMA foreign_key_list('${name}')`)
      .all()
    return {
      name,
      primaryKey: columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      columns: columns.map((column) => ({
        table: name,
        name: column.name,
        type: /INT/i.test(column.type) ? 'integer' : column.type.toLowerCase(),
        required: column.notnull === 1 || column.pk > 0,
        primaryKey: column.pk > 0,
        foreignKey: foreignKeys.some((foreignKey) => foreignKey.from === column.name),
        foreignTargets: foreignKeys
          .filter((foreignKey) => foreignKey.from === column.name)
          .map((foreignKey) => ({ table: foreignKey.table, column: foreignKey.to })),
      })),
    }
  })
}

type SchemaModule = Record<string, unknown>

export function hostedKeyTablesFromModules(modules: readonly SchemaModule[]): KeyTable[] {
  const tables = modules.flatMap((schema) =>
    Object.values(schema).filter((value): value is AnyPgTable => is(value, PgTable)),
  )
  return tables
    .map((table) => {
      const config = getTableConfig(table)
      const primaryColumns = [
        ...config.columns.filter((column) => column.primary),
        ...config.primaryKeys.flatMap((primaryKey) => primaryKey.columns),
      ]
      const primaryNames = new Set(primaryColumns.map((column) => column.name))
      const foreignColumns = config.foreignKeys.flatMap((foreignKey) => {
        const reference = foreignKey.reference()
        return reference.columns.flatMap((column, index) => {
          const foreignColumn = reference.foreignColumns[index]
          return foreignColumn
            ? [
                {
                  name: column.name,
                  target: {
                    table: getTableConfig(reference.foreignTable).name,
                    column: foreignColumn.name,
                  },
                },
              ]
            : []
        })
      })
      return {
        name: config.name,
        primaryKey: [...primaryNames],
        columns: config.columns.map((column) => ({
          table: config.name,
          name: column.name,
          type:
            column.getSQLType() === 'uuid'
              ? 'uuid'
              : /^(?:bigint|integer|smallint|serial|bigserial)/.test(column.getSQLType())
                ? 'integer'
                : column.getSQLType(),
          required: column.notNull,
          primaryKey: primaryNames.has(column.name),
          foreignKey: foreignColumns.some((foreignColumn) => foreignColumn.name === column.name),
          foreignTargets: foreignColumns
            .filter((foreignColumn) => foreignColumn.name === column.name)
            .map((foreignColumn) => foreignColumn.target),
        })),
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function hostedKeyTables(): Promise<KeyTable[]> {
  const configured = Array.isArray(drizzleConfig.schema)
    ? drizzleConfig.schema
    : [drizzleConfig.schema]
  const modules = await Promise.all(
    configured.map((path) => import(pathToFileURL(resolve(import.meta.dir, '..', path!)).href)),
  )
  return hostedKeyTablesFromModules(modules)
}
