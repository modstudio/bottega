import type { StateClassDeclaration } from './identity-state-classes.ts'

type Store = 'orchestrator' | 'hub'
type StateClassInput = {
  tables: Readonly<Record<Store, readonly string[]>>
  declarations: readonly StateClassDeclaration[]
  outboxSources: readonly string[]
  pushableHubTables: readonly string[]
  hostedTables: readonly string[]
}

const remedy = 'edit scripts/identity-state-classes.ts'

function declaredRows(declarations: readonly StateClassDeclaration[]) {
  const declared = new Map<string, StateClassDeclaration[]>()
  for (const declaration of declarations) {
    const key = `${declaration.store}.${declaration.table}`
    declared.set(key, [...(declared.get(key) ?? []), declaration])
  }
  return declared
}

function coverageRefusals(
  existing: ReadonlySet<string>,
  declared: ReadonlyMap<string, readonly StateClassDeclaration[]>,
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

function hostedFirstRefusals(
  key: string,
  row: StateClassDeclaration,
  hostedTables: ReadonlySet<string>,
): string[] {
  const hasCounterpart = typeof row.counterpart === 'string' && row.counterpart.trim() !== ''
  const hasTask = typeof row.task === 'string' && row.task.trim() !== ''
  const refusals: string[] = []
  if (hasCounterpart === hasTask)
    refusals.push(
      `${key}: hosted-first declaration must name exactly one counterpart or task; remedy: ${remedy}`,
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
  row: StateClassDeclaration,
  outboxSources: ReadonlySet<string>,
  hostedTables: ReadonlySet<string>,
): string[] {
  const refusals: string[] = []
  const isOutboxSource = row.store === 'orchestrator' && outboxSources.has(row.table)
  if (row.class === 'evidence' && !isOutboxSource)
    refusals.push(
      `${key}: evidence table is not an outbox source; remedy: ${remedy} with its ruled class`,
    )
  if (isOutboxSource && row.class !== 'evidence')
    refusals.push(
      `${key}: outbox source is declared ${row.class} instead of evidence; remedy: ${remedy} with class evidence`,
    )
  if (row.class === 'hosted-first') refusals.push(...hostedFirstRefusals(key, row, hostedTables))
  if (
    row.class === 'machine-only' &&
    (row.reason.trim() === '' || typeof row.ruling !== 'string' || row.ruling.trim() === '')
  )
    refusals.push(
      `${key}: machine-only declaration needs a non-empty reason and ruling; remedy: ${remedy}`,
    )
  return refusals
}

function pushableRefusals(
  pushableHubTables: readonly string[],
  declared: ReadonlyMap<string, readonly StateClassDeclaration[]>,
): string[] {
  return pushableHubTables.flatMap((hostedTable) => {
    const key = `hub.${hostedTable.replace(/^hub_/, '')}`
    const rows = declared.get(key) ?? []
    if (
      rows.length !== 1 ||
      (rows[0]?.class === 'hosted-first' && rows[0].counterpart === hostedTable)
    )
      return []
    return [
      `${key}: pushable hub table ${hostedTable} must be hosted-first with that counterpart; remedy: ${remedy}`,
    ]
  })
}

export function stateClassRefusals(input: StateClassInput): string[] {
  const existing = new Set(
    (['orchestrator', 'hub'] as const).flatMap((store) =>
      input.tables[store].map((table) => `${store}.${table}`),
    ),
  )
  const declared = declaredRows(input.declarations)
  const outboxSources = new Set(input.outboxSources)
  const hostedTables = new Set(input.hostedTables)
  return [
    ...coverageRefusals(existing, declared),
    ...[...declared].flatMap(([key, rows]) =>
      rows.flatMap((row) => declarationRefusals(key, row, outboxSources, hostedTables)),
    ),
    ...pushableRefusals(input.pushableHubTables, declared),
  ].sort()
}
