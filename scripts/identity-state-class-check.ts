import type { StateClassStore } from './identity-inventory.ts'
import type { StateClassDeclaration, TableStateClassDeclaration } from './identity-state-classes.ts'

type StateClassInput = {
  tables: Readonly<Record<StateClassStore, readonly string[]>>
  declarations: readonly StateClassDeclaration[]
  outboxKindSources: Readonly<Record<string, { source: string; carries?: readonly string[] }>>
  outboxTables: readonly string[]
  pushableHubTables: readonly { hosted: string; local: string }[]
  hostedTables: readonly string[]
  allowedHostedOutbox: readonly string[]
  allowedHostedCaches: readonly string[]
}

export type StateClassBaseline = {
  hostedOutbox: readonly string[]
  hostedCaches: readonly string[]
}

const remedy = 'edit scripts/identity-state-classes.ts'

function declaredRows(declarations: readonly StateClassDeclaration[]) {
  const declared = new Map<string, TableStateClassDeclaration[]>()
  for (const declaration of declarations) {
    if (!('table' in declaration)) continue
    const key = `${declaration.store}.${declaration.table}`
    declared.set(key, [...(declared.get(key) ?? []), declaration])
  }
  return declared
}

function coverageRefusals(
  existing: ReadonlySet<string>,
  declared: ReadonlyMap<string, readonly TableStateClassDeclaration[]>,
): string[] {
  const refusals: string[] = []
  for (const key of existing) {
    const count = declared.get(key)?.length ?? 0
    if (count === 0)
      refusals.push(`${key}: table has no state class declaration; remedy: ${remedy}`)
    if (count > 1)
      refusals.push(
        `${key}: table has ${count} state class declarations; remedy: ${remedy} so it has exactly one row`,
      )
  }
  for (const key of declared.keys()) {
    if (!existing.has(key))
      refusals.push(
        `${key}: state class declaration is stale because the table does not exist; remedy: remove its row from scripts/identity-state-classes.ts`,
      )
  }
  return refusals
}

function hostedRefusals(
  key: string,
  row: TableStateClassDeclaration,
  hostedTables: ReadonlySet<string>,
): string[] {
  const hasCounterpart = typeof row.counterpart === 'string' && row.counterpart.trim() !== ''
  const hasTask = typeof row.task === 'string' && row.task.trim() !== ''
  const refusals: string[] = []
  if (hasCounterpart === hasTask)
    refusals.push(
      `${key}: hosted declaration must name exactly one counterpart or task; remedy: ${remedy}`,
    )
  if (hasCounterpart && !hostedTables.has(row.counterpart!))
    refusals.push(
      `${key}: hosted counterpart ${row.counterpart} does not exist; remedy: ${remedy} with an existing hosted table`,
    )
  if (hasTask && !/^DEV-[1-9]\d*$/.test(row.task!))
    refusals.push(
      `${key}: hosted task ${row.task} is not a DEV tracker key; remedy: ${remedy} with a key of the form DEV-<n>`,
    )
  return refusals
}

function declarationRefusals(
  key: string,
  row: TableStateClassDeclaration,
  outboxTables: ReadonlySet<string>,
  hostedTables: ReadonlySet<string>,
  allowedHostedOutbox: ReadonlySet<string>,
  allowedHostedCaches: ReadonlySet<string>,
): string[] {
  const refusals: string[] = []
  const isOutboxSource = outboxTables.has(key)
  const hasTask = typeof row.task === 'string' && row.task.trim() !== ''
  if (row.class === 'synced' && !isOutboxSource && !hasTask)
    refusals.push(
      `${key}: synced table is not an outbox source and names no task for its hosted home; remedy: ${remedy} with its task`,
    )
  if (row.class === 'synced' && hasTask && !/^DEV-[1-9]\d*$/.test(row.task!))
    refusals.push(
      `${key}: ${row.class} task ${row.task} is not a DEV tracker key; remedy: ${remedy} with a key of the form DEV-<n>`,
    )
  if (isOutboxSource && row.class === 'machine')
    refusals.push(
      `${key}: outbox source is declared ${row.class} instead of synced; remedy: ${remedy} with class synced`,
    )
  if (isOutboxSource && row.class === 'hosted' && !allowedHostedOutbox.has(key))
    refusals.push(
      `${key}: hosted table has a new outbox write path; remedy: write it directly or remove the outbox kind`,
    )
  if (row.cache && (row.class !== 'hosted' || !allowedHostedCaches.has(key)))
    refusals.push(
      `${key}: hosted table has a new local cache; remedy: read it from the hosted record instead`,
    )
  if (row.class === 'hosted') refusals.push(...hostedRefusals(key, row, hostedTables))
  if (
    row.class === 'machine' &&
    (row.reason.trim() === '' || typeof row.ruling !== 'string' || row.ruling.trim() === '')
  )
    refusals.push(
      `${key}: machine declaration needs a non-empty reason and ruling; remedy: ${remedy}`,
    )
  return refusals
}

function pushableRefusals(
  pushableHubTables: readonly { hosted: string; local: string }[],
  declared: ReadonlyMap<string, readonly TableStateClassDeclaration[]>,
): string[] {
  return pushableHubTables.flatMap(({ hosted, local }) => {
    const key = `hub.${local}`
    const rows = declared.get(key) ?? []
    if (rows.length === 0)
      return [
        `${key}: pushable hub table ${hosted} must be declared hosted with counterpart ${hosted}, or synced; remedy: ${remedy}`,
      ]
    if (rows.length !== 1) return []
    if (
      rows[0]?.class === 'synced' ||
      (rows[0]?.class === 'hosted' && rows[0].counterpart === hosted)
    )
      return []
    return [
      `${key}: pushable hub table ${hosted} must be declared hosted with counterpart ${hosted}, or synced; remedy: ${remedy}`,
    ]
  })
}

function outboxTableRefusals(
  sources: Readonly<Record<string, { source: string; carries?: readonly string[] }>>,
  orchestratorTables: ReadonlySet<string>,
): string[] {
  return Object.entries(sources).flatMap(([kind, { source, carries = [] }]) =>
    [source, ...carries]
      .filter((table) => !orchestratorTables.has(table))
      .map(
        (table) =>
          `outbox kind ${kind} names missing local orchestrator table ${table}; remedy: edit scripts/identity-state-class-facts.ts`,
      ),
  )
}

export function stateClassBaselineRefusals(
  current: StateClassBaseline,
  previous: StateClassBaseline | null,
  declarations: readonly StateClassDeclaration[],
  outboxTables: readonly string[],
): string[] {
  const hostedOutbox = new Set(
    declarations.flatMap((row) =>
      'table' in row && row.class === 'hosted' ? [`${row.store}.${row.table}`] : [],
    ),
  )
  const hostedCaches = new Set(
    declarations.flatMap((row) =>
      'table' in row && row.class === 'hosted' && row.cache ? [`${row.store}.${row.table}`] : [],
    ),
  )
  const outbox = new Set(outboxTables)
  const stale = [
    ...current.hostedOutbox
      .filter((key) => !hostedOutbox.has(key) || !outbox.has(key))
      .map(
        (key) =>
          `state class baseline hostedOutbox entry ${key} is stale; remedy: remove it from scripts/identity-state-class-baseline.json`,
      ),
    ...current.hostedCaches
      .filter((key) => !hostedCaches.has(key))
      .map(
        (key) =>
          `state class baseline hostedCaches entry ${key} is stale; remedy: remove it from scripts/identity-state-class-baseline.json`,
      ),
  ]
  const growth = previous
    ? (['hostedOutbox', 'hostedCaches'] as const).flatMap((field) => {
        const before = new Set(previous[field])
        return current[field]
          .filter((key) => !before.has(key))
          .map(
            (key) =>
              `state class baseline ${field} gained ${key}; remedy: remove the hosted outbox or cache instead of widening the baseline`,
          )
      })
    : []
  return [...stale, ...growth].sort()
}

export function stateClassRefusals(input: StateClassInput): string[] {
  const existing = new Set(
    (['orchestrator', 'hub'] as const).flatMap((store) =>
      input.tables[store].map((table) => `${store}.${table}`),
    ),
  )
  const declared = declaredRows(input.declarations)
  const orchestratorTables = new Set(input.tables.orchestrator)
  const outboxTables = new Set(input.outboxTables)
  const hostedTables = new Set(input.hostedTables)
  const stateFileRefusals = input.declarations.flatMap((row) => {
    if (!('path' in row)) return []
    return row.reason.trim() && row.ruling.trim()
      ? []
      : [
          `state-directory.${row.path}: machine declaration needs a non-empty reason and ruling; remedy: ${remedy}`,
        ]
  })
  return [
    ...coverageRefusals(existing, declared),
    ...[...declared].flatMap(([key, rows]) =>
      rows.flatMap((row) =>
        declarationRefusals(
          key,
          row,
          outboxTables,
          hostedTables,
          new Set(input.allowedHostedOutbox),
          new Set(input.allowedHostedCaches),
        ),
      ),
    ),
    ...pushableRefusals(input.pushableHubTables, declared),
    ...outboxTableRefusals(input.outboxKindSources, orchestratorTables),
    ...stateFileRefusals,
  ].sort()
}
