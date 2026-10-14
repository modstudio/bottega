import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DAY_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type PushableHubChangeTable,
} from './push-contract.ts'

export type IdentitySetComparison = {
  both: number
  machineOnly: string[]
  hostedOnly: string[]
  inFlight: string[]
}

type TableAudit = IdentitySetComparison & {
  table: PushableHubChangeTable
  pulled: boolean
}

export type SpaceAudit = { spaceId: string; tables: TableAudit[] }

export type UnroutableRows = {
  project: string
  reason: string
  table: PushableHubChangeTable
  ids: string[]
}

export type StuckRow = { table: string; id: string; reason: string | null }

export type RepairCandidate = {
  table: PushableHubChangeTable
  id: string
  fields: string[] | null
}

export type UnrepairableRow = {
  table: PushableHubChangeTable
  id: string
  reason: string
  remedy: string
}

export type RoutedMachineRow =
  | { table: PushableHubChangeTable; id: string; destinationSpaceId: string }
  | { table: PushableHubChangeTable; id: string; project: string; reason: string }

export type HostedTableIds = {
  table: PushableHubChangeTable
  spaceId: string
  ids: readonly string[]
}

export type AuditOutboxEntry = {
  table: string
  rowId: string
  quarantinedAt: string | null
  quarantineReason: string | null
}

export type DrainAudit = {
  rejected: number
  quarantined: number
  waitingOnRouting: Record<string, number>
  waitingOnHostedHub?: Record<string, number>
  hostedReachable?: boolean
  skippedCapability?: boolean
}

export type TaskPushPlan = {
  spaces: SpaceAudit[]
  unroutable: UnroutableRows[]
  stuck: StuckRow[]
  repair: RepairCandidate[]
  unrepairable: UnrepairableRow[]
}

/** Classify one table's machine, hosted, pending, and stuck ids. Pending is in flight; stuck is not missing. */
export function compareIdentitySets(
  machineIds: readonly string[],
  hostedIds: readonly string[],
  pendingIds: ReadonlySet<string>,
  stuckIds: ReadonlySet<string> = new Set(),
): IdentitySetComparison {
  const hosted = new Set(hostedIds)
  const machine = new Set(machineIds)
  let both = 0
  const machineOnly: string[] = []
  const inFlight: string[] = []
  for (const id of machine) {
    if (hosted.has(id)) both++
    else if (pendingIds.has(id)) inFlight.push(id)
    else if (!stuckIds.has(id)) machineOnly.push(id)
  }
  return {
    both,
    machineOnly: machineOnly.sort(),
    hostedOnly: hostedIds.filter((id) => !machine.has(id)).sort(),
    inFlight: inFlight.sort(),
  }
}

type RepairDecision =
  | { repairable: true; fields: string[] | null }
  | { repairable: false; reason: string }

export function repairDecisionFor(table: PushableHubChangeTable): RepairDecision {
  switch (table) {
    case HOSTED_TASK_TABLE:
    case HOSTED_COMMENT_TABLE:
    case HOSTED_DOCUMENT_TABLE:
      return { repairable: true, fields: [] }
    case HOSTED_STATUS_EVENT_TABLE:
    case HOSTED_INTERVAL_TABLE:
    case HOSTED_DAY_TABLE:
    case HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE:
      return { repairable: true, fields: null }
    case HOSTED_NOTE_TABLE:
      return {
        repairable: false,
        reason:
          'the hosted record assigns note numbers, so a missing note cannot be created by push',
      }
    default:
      return assertNever(table)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled pushable hub table: ${value}`)
}

export function drainFailsAudit(drain: DrainAudit): boolean {
  if (drain.rejected > 0 || drain.quarantined > 0) return true
  if (drain.skippedCapability) return true
  if (drain.hostedReachable === false) return true
  if (Object.keys(drain.waitingOnRouting).length > 0) return true
  return Object.keys(drain.waitingOnHostedHub ?? {}).length > 0
}

export function taskPushVerdict(plan: TaskPushPlan, drain: DrainAudit | null): boolean {
  if (plan.unroutable.length > 0 || plan.stuck.length > 0 || plan.unrepairable.length > 0)
    return false
  if (plan.spaces.some((space) => space.tables.some((table) => pulledHostedOnly(table))))
    return false
  if (drain) return !drainFailsAudit(drain)
  return !plan.spaces.some((space) => space.tables.some((table) => table.machineOnly.length > 0))
}

function pulledHostedOnly(table: TableAudit): boolean {
  return table.pulled && table.hostedOnly.length > 0
}

function pendingIds(outbox: readonly AuditOutboxEntry[], table: string): Set<string> {
  return new Set(
    outbox
      .filter((entry) => entry.table === table && !entry.quarantinedAt)
      .map((entry) => entry.rowId),
  )
}

function stuckIds(outbox: readonly AuditOutboxEntry[], table: string): Set<string> {
  return new Set(
    outbox
      .filter((entry) => entry.table === table && entry.quarantinedAt)
      .map((entry) => entry.rowId),
  )
}

function machineIdsFor(
  machine: readonly RoutedMachineRow[],
  table: PushableHubChangeTable,
  spaceId: string,
): string[] {
  return machine
    .filter(
      (row) =>
        row.table === table && 'destinationSpaceId' in row && row.destinationSpaceId === spaceId,
    )
    .map((row) => row.id)
}

function hostedIdsFor(
  hosted: readonly HostedTableIds[],
  table: PushableHubChangeTable,
  spaceId: string,
): readonly string[] {
  return hosted.find((row) => row.table === table && row.spaceId === spaceId)?.ids ?? []
}

function unroutableRows(machine: readonly RoutedMachineRow[]): UnroutableRows[] {
  const grouped = new Map<string, UnroutableRows>()
  for (const row of machine) {
    if ('destinationSpaceId' in row) continue
    const key = `${row.table}\0${row.project}\0${row.reason}`
    const selected = grouped.get(key) ?? {
      project: row.project,
      reason: row.reason,
      table: row.table,
      ids: [],
    }
    selected.ids.push(row.id)
    grouped.set(key, selected)
  }
  return [...grouped.values()].map((row) => ({ ...row, ids: row.ids.sort() }))
}

function stuckRows(outbox: readonly AuditOutboxEntry[], tables: ReadonlySet<string>): StuckRow[] {
  return outbox
    .filter((entry) => entry.quarantinedAt && tables.has(entry.table))
    .map((entry) => ({
      table: entry.table,
      id: entry.rowId,
      reason: entry.quarantineReason,
    }))
    .sort((left, right) =>
      left.table === right.table
        ? left.id.localeCompare(right.id)
        : left.table.localeCompare(right.table),
    )
}

function repairCandidates(spaces: readonly SpaceAudit[]): RepairCandidate[] {
  const repair: RepairCandidate[] = []
  for (const space of spaces)
    for (const table of space.tables)
      for (const id of table.machineOnly) {
        const decision = repairDecisionFor(table.table)
        if (decision.repairable) repair.push({ table: table.table, id, fields: decision.fields })
      }
  return repair
}

function unrepairableRows(spaces: readonly SpaceAudit[]): UnrepairableRow[] {
  const rows: UnrepairableRow[] = []
  for (const space of spaces)
    for (const table of space.tables) {
      const decision = repairDecisionFor(table.table)
      if (!decision.repairable)
        for (const id of table.machineOnly)
          rows.push({
            table: table.table,
            id,
            reason: decision.reason,
            remedy: `inspect with \`${PLATFORM_SLUG} note list --json\` and find record_id ${id}. The machine has no command to create a note the hosted record lacks, so the choice is to file it again or drop the machine copy. Dropping the machine copy currently queues an update that the hosted record can only reject.`,
          })
    }
  return rows
}

export function planTaskPushAudit(input: {
  spaces: readonly string[]
  tables: readonly PushableHubChangeTable[]
  machine: readonly RoutedMachineRow[]
  hosted: readonly HostedTableIds[]
  outbox: readonly AuditOutboxEntry[]
  pulledTables: ReadonlySet<string>
}): TaskPushPlan {
  const spaces: SpaceAudit[] = input.spaces.map((spaceId) => ({
    spaceId,
    tables: input.tables.map((table) => ({
      table,
      pulled: input.pulledTables.has(table),
      ...compareIdentitySets(
        machineIdsFor(input.machine, table, spaceId),
        hostedIdsFor(input.hosted, table, spaceId),
        pendingIds(input.outbox, table),
        stuckIds(input.outbox, table),
      ),
    })),
  }))
  return {
    spaces,
    unroutable: unroutableRows(input.machine),
    stuck: stuckRows(input.outbox, new Set(input.tables)),
    repair: repairCandidates(spaces),
    unrepairable: unrepairableRows(spaces),
  }
}
