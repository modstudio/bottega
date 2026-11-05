// concern: storage lifecycle contract
/** Shared declaration and report shapes. Store owners supply declarations and measurements. */

const LIFECYCLE_CLASSES = ['record', 'payload', 'telemetry', 'journal', 'cache', 'machine'] as const
export type LifecycleClass = (typeof LIFECYCLE_CLASSES)[number]
const LIFECYCLE_SLICES = [
  'outbox',
  'change-logs',
  'telemetry',
  'payloads',
  'churn',
  'working-set',
] as const
export type LifecycleSlice = (typeof LIFECYCLE_SLICES)[number]
export type LifecycleStore = 'orchestrator' | 'hub' | 'hosted'

type PayloadColumnLifecycle = { column: string; keep: string }
export type TableLifecycle = {
  store: LifecycleStore
  table: string
  class: LifecycleClass
  keep: string
  remover: 'kept' | `${string}#${string}` | null
  slice?: LifecycleSlice
  payloadColumns?: readonly PayloadColumnLifecycle[]
}

export type TableStorageMeasurement = {
  store: LifecycleStore
  table: string
  bytes: number
  rows: number
  nLiveTup?: number
  nTupUpd?: number
  nDeadTup?: number
}

type StorageTableReport = TableStorageMeasurement & {
  class: LifecycleClass
  remover: TableLifecycle['remover']
  slice?: LifecycleSlice
}

export type TableStorageReport = {
  tables: StorageTableReport[]
  missing: { store: LifecycleStore; reason: string }[]
  undeclared: Pick<TableStorageMeasurement, 'store' | 'table' | 'bytes'>[]
  findings: {
    slice: LifecycleSlice
    tables: { store: LifecycleStore; table: string; bytes: number }[]
  }[]
  kept: { store: LifecycleStore; table: string; bytes: number }[]
}

export const LIFECYCLE_KEEP: Readonly<Record<LifecycleClass, string>> = {
  record: 'The authoritative rows are kept indefinitely.',
  payload:
    'Bulky bodies stay inline for the hot window, then move behind an object-storage pointer.',
  telemetry: 'Raw samples stay for the telemetry window, followed by daily rollups.',
  journal: 'Delivery and change rows stay until acknowledgement or the declared horizon.',
  cache: 'Hosted rows stay for the window read locally and can be fetched again.',
  machine: "Machine-only rows stay for their owner's declared local lifetime.",
}

export function entries(
  store: LifecycleStore,
  names: readonly string[],
  lifecycleClass: LifecycleClass,
  remover: TableLifecycle['remover'],
  slice?: LifecycleSlice,
): TableLifecycle[] {
  return names.map((table) => ({
    store,
    table,
    class: lifecycleClass,
    keep: LIFECYCLE_KEEP[lifecycleClass],
    remover,
    ...(slice ? { slice } : {}),
  }))
}

export function payload(column: string): PayloadColumnLifecycle {
  return {
    column,
    keep: LIFECYCLE_KEEP.payload,
  }
}

export function boundedMachine(
  store: LifecycleStore,
  names: readonly string[],
  bound: string,
): TableLifecycle[] {
  return names.map((table) => ({ store, table, class: 'machine', keep: bound, remover: 'kept' }))
}

export function joinStorageMeasurements(
  declarations: readonly TableLifecycle[],
  measurements: readonly TableStorageMeasurement[],
  missing: TableStorageReport['missing'] = [],
): TableStorageReport {
  const declared = new Map(declarations.map((entry) => [`${entry.store}.${entry.table}`, entry]))
  const undeclared: TableStorageReport['undeclared'] = []
  const tables = measurements.flatMap((measurement) => {
    const declaration = declared.get(`${measurement.store}.${measurement.table}`)
    if (!declaration) {
      undeclared.push({
        store: measurement.store,
        table: measurement.table,
        bytes: measurement.bytes,
      })
      return []
    }
    return [
      {
        ...measurement,
        class: declaration.class,
        remover: declaration.remover,
        ...(declaration.slice ? { slice: declaration.slice } : {}),
      },
    ]
  })
  const slices = new Map<LifecycleSlice, TableStorageReport['findings'][number]['tables']>()
  for (const table of tables) {
    if (table.remover !== null || !table.slice) continue
    const values = slices.get(table.slice) ?? []
    values.push({ store: table.store, table: table.table, bytes: table.bytes })
    slices.set(table.slice, values)
  }
  return {
    tables: tables.sort((left, right) =>
      `${left.store}.${left.table}`.localeCompare(`${right.store}.${right.table}`),
    ),
    missing,
    undeclared: undeclared.sort((left, right) =>
      `${left.store}.${left.table}`.localeCompare(`${right.store}.${right.table}`),
    ),
    findings: [...slices].map(([slice, values]) => ({ slice, tables: values })),
    kept: tables
      .filter((table) => table.remover === 'kept')
      .map((table) => ({ store: table.store, table: table.table, bytes: table.bytes })),
  }
}
