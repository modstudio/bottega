import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db, writeTransaction } from './db.ts'
import { rememberHostedInstall } from './install-binding.ts'
import { drainHostedOutbox, type HostedOutboxReport, queueHostedChange } from './outbox.ts'
import { projects } from './projects.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DAY_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  PUSHABLE_HUB_CHANGE_TABLES,
  type PushableHubChangeTable,
} from './push-contract.ts'
import {
  assertSpaceIdentitySet,
  hostedIdentitySet,
  hostedPushChanges,
  hostedTaskIdentity,
  type TaskFetch,
} from './task-client.ts'
import {
  partitionProjectRows,
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
  taskPullSpaces,
} from './task-project-space.ts'
import {
  type AuditOutboxEntry,
  type DrainAudit,
  type HostedTableIds,
  planTaskPushAudit,
  type RepairCandidate,
  type RoutedMachineRow,
  type SpaceAudit,
  type StuckRow,
  taskPushVerdict,
  type UnrepairableRow,
  type UnroutableRows,
} from './task-push-plan.ts'

type Options = {
  repair?: boolean
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
  identity?: typeof hostedTaskIdentity
  listIds?: typeof hostedIdentitySet
  drain?: typeof drainHostedOutbox
  registered?: () => RegisteredTaskSpace[]
}

type MachineRow = { id: string; project_name: string | null }
type RequestOptions = { baseUrl?: string; token?: string | null; fetch?: TaskFetch }

export type TaskPushReport = {
  spaces: SpaceAudit[]
  unroutable: UnroutableRows[]
  stuck: StuckRow[]
  unrepairable: UnrepairableRow[]
  drain: HostedOutboxReport | null
  ok: boolean
}

function machineRowsFor(table: PushableHubChangeTable): MachineRow[] {
  switch (table) {
    case HOSTED_TASK_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT record_id id, project project_name FROM task WHERE record_id IS NOT NULL`,
        )
        .all()
    case HOSTED_COMMENT_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT c.record_id id, t.project project_name FROM task_comment c
         JOIN task t ON t.record_id=c.task_record_id WHERE c.record_id IS NOT NULL`,
        )
        .all()
    case HOSTED_DOCUMENT_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT d.record_id id, t.project project_name FROM task_document d
         JOIN task t ON t.record_id=d.task_record_id WHERE d.record_id IS NOT NULL`,
        )
        .all()
    case HOSTED_STATUS_EVENT_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT e.record_id id, t.project project_name FROM task_status_event e
         JOIN task t ON t.record_id=e.task_record_id WHERE e.record_id IS NOT NULL`,
        )
        .all()
    case HOSTED_INTERVAL_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT record_id id, project project_name FROM interval WHERE record_id IS NOT NULL`,
        )
        .all()
    case HOSTED_DAY_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT record_id id, NULL project_name FROM day WHERE record_id IS NOT NULL`,
        )
        .all()
    case HOSTED_NOTE_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT record_id id, project project_name FROM note WHERE record_id IS NOT NULL`,
        )
        .all()
    case HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE:
      return db()
        .query<MachineRow, []>(
          `SELECT a.record_id id, n.project project_name FROM note_acknowledgement a
           JOIN note n ON n.record_id=a.note_record_id WHERE a.record_id IS NOT NULL`,
        )
        .all()
    default:
      return assertNever(table)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled pushable hub table: ${value}`)
}

function machinePullsTable(table: PushableHubChangeTable): boolean {
  switch (table) {
    case HOSTED_TASK_TABLE:
    case HOSTED_COMMENT_TABLE:
    case HOSTED_DOCUMENT_TABLE:
    case HOSTED_STATUS_EVENT_TABLE:
    case HOSTED_NOTE_TABLE:
    case HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE:
      return true
    case HOSTED_INTERVAL_TABLE:
    case HOSTED_DAY_TABLE:
      return false
    default:
      return assertNever(table)
  }
}

function outboxEntries(): AuditOutboxEntry[] {
  return db()
    .query<
      {
        table_name: string
        row_id: string
        quarantined_at: string | null
        quarantine_reason: string | null
      },
      []
    >(`SELECT table_name, row_id, quarantined_at, quarantine_reason FROM hosted_outbox`)
    .all()
    .map((row) => ({
      table: row.table_name,
      rowId: row.row_id,
      quarantinedAt: row.quarantined_at,
      quarantineReason: row.quarantine_reason,
    }))
}

function routedMachineRows(
  table: PushableHubChangeTable,
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): RoutedMachineRow[] {
  const partitioned = partitionProjectRows(machineRowsFor(table), registered, identity)
  const routed: RoutedMachineRow[] = []
  for (const [spaceId, rows] of partitioned.destinations)
    for (const row of rows) routed.push({ table, id: row.id, destinationSpaceId: spaceId })
  for (const [project, refusal] of partitioned.refusals)
    for (const row of refusal.rows)
      routed.push({ table, id: row.id, project, reason: refusal.reason })
  return routed
}

async function hostedIdsFor(
  table: PushableHubChangeTable,
  spaceId: string,
  listIds: typeof hostedIdentitySet,
  requestOptions: RequestOptions,
): Promise<string[]> {
  const ids: string[] = []
  let after: string | null = null
  for (;;) {
    const page = await listIds(table, { ...requestOptions, recordSpace: spaceId, after })
    ids.push(...page.ids)
    if (!page.more) return ids
    after = page.ids.at(-1) ?? null
  }
}

async function hostedTableIds(
  spaces: readonly string[],
  listIds: typeof hostedIdentitySet,
  requestOptions: RequestOptions,
): Promise<HostedTableIds[]> {
  const hosted: HostedTableIds[] = []
  for (const table of PUSHABLE_HUB_CHANGE_TABLES)
    for (const spaceId of spaces)
      hosted.push({
        table,
        spaceId,
        ids: await hostedIdsFor(table, spaceId, listIds, requestOptions),
      })
  return hosted
}

function queueRepairs(candidates: readonly RepairCandidate[]) {
  for (const table of PUSHABLE_HUB_CHANGE_TABLES) {
    const rows = candidates.filter((candidate) => candidate.table === table)
    if (!rows.length) continue
    writeTransaction((conn) => {
      for (const row of rows)
        queueHostedChange(conn, table, row.id, 'upsert', undefined, row.fields)
    })
  }
}

function drainAudit(drain: HostedOutboxReport): DrainAudit {
  return {
    rejected: drain.rejected,
    quarantined: drain.quarantined,
    waitingOnRouting: drain.waitingOnRouting,
    waitingOnHostedHub: drain.waitingOnHostedHub,
    hostedReachable: drain.hostedReachable,
    skippedCapability: drain.skippedCapability,
  }
}

export async function pushTasks(options: Options = {}): Promise<TaskPushReport> {
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await (options.identity ?? hostedTaskIdentity)(requestOptions)
  assertSpaceIdentitySet(identity)
  rememberHostedInstall(identity.activeSpaceId)
  const registered = (options.registered ?? projects)()
  const spaces = taskPullSpaces(registered, identity)
  const machine = PUSHABLE_HUB_CHANGE_TABLES.flatMap((table) =>
    routedMachineRows(table, registered, identity),
  )
  const plan = planTaskPushAudit({
    spaces,
    tables: PUSHABLE_HUB_CHANGE_TABLES,
    machine,
    hosted: await hostedTableIds(spaces, options.listIds ?? hostedIdentitySet, requestOptions),
    outbox: outboxEntries(),
    pulledTables: new Set(PUSHABLE_HUB_CHANGE_TABLES.filter(machinePullsTable)),
  })
  if (!options.repair)
    return {
      spaces: plan.spaces,
      unroutable: plan.unroutable,
      stuck: plan.stuck,
      unrepairable: plan.unrepairable,
      drain: null,
      ok: taskPushVerdict(plan, null),
    }
  queueRepairs(plan.repair)
  const drain = await (options.drain ?? drainHostedOutbox)({
    identity: async () => identity,
    registered: () => registered,
    push: (changes, pushOptions) =>
      hostedPushChanges(changes, { ...requestOptions, ...pushOptions }),
  })
  return {
    spaces: plan.spaces,
    unroutable: plan.unroutable,
    stuck: plan.stuck,
    unrepairable: plan.unrepairable,
    drain,
    ok: taskPushVerdict(plan, drainAudit(drain)),
  }
}

function idLines(heading: string, rows: Array<{ spaceId: string; table: string; ids: string[] }>) {
  const listed = rows.filter((row) => row.ids.length)
  if (!listed.length) return []
  const lines = [heading]
  for (const row of listed) {
    lines.push(`  ${row.spaceId} ${row.table}`)
    for (const id of row.ids) lines.push(`    ${id}`)
  }
  return lines
}

function drainFailureLines(drain: HostedOutboxReport): string[] {
  const lines: string[] = []
  if (drain.rejected > 0) lines.push('repair drain rejected rows')
  if (drain.quarantined > 0) lines.push('repair drain quarantined rows')
  if (drain.skippedCapability) lines.push('repair drain left rows waiting: table not accepted')
  if (drain.hostedReachable === false) lines.push('repair drain left rows waiting: hub unreachable')
  const routing = Object.entries(drain.waitingOnRouting)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(',')
  if (routing) lines.push(`repair drain left rows waiting: routing ${routing}`)
  const hosted = Object.entries(drain.waitingOnHostedHub ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([table, count]) => `${table}=${count}`)
    .join(',')
  if (hosted) lines.push(`repair drain left rows waiting: table not accepted ${hosted}`)
  return lines
}

function unrepairableLines(rows: readonly UnrepairableRow[]): string[] {
  return rows.flatMap((row) => [
    `unrepairable ${row.table} ${row.id} ${row.reason}`,
    `  remedy: ${row.remedy}`,
  ])
}

export function formatTaskPushReport(report: TaskPushReport): string {
  const lines: string[] = []
  for (const space of report.spaces) {
    lines.push(`space ${space.spaceId}`)
    for (const table of space.tables)
      lines.push(
        `  ${table.table} both=${table.both} machine-only=${table.machineOnly.length} hosted-only=${table.hostedOnly.length} in-flight=${table.inFlight.length}`,
      )
  }
  lines.push(
    ...idLines(
      'Only on the machine',
      report.spaces.flatMap((space) =>
        space.tables.map((table) => ({
          spaceId: space.spaceId,
          table: table.table,
          ids: table.machineOnly,
        })),
      ),
    ),
  )
  const hostedPulled = report.spaces.flatMap((space) =>
    space.tables
      .filter((table) => table.pulled)
      .map((table) => ({ spaceId: space.spaceId, table: table.table, ids: table.hostedOnly })),
  )
  const familyLines = idLines('Only on the hosted record', hostedPulled)
  if (familyLines.length) {
    lines.push(...familyLines)
    lines.push('The machine has no command to fetch them yet.')
  }
  const evidenceCounts = report.spaces.flatMap((space) =>
    space.tables
      .filter((table) => !table.pulled && table.hostedOnly.length)
      .map((table) => ({
        spaceId: space.spaceId,
        table: table.table,
        count: table.hostedOnly.length,
      })),
  )
  if (evidenceCounts.length) {
    lines.push('Only on the hosted record, written by another machine or no longer held here')
    for (const row of evidenceCounts) lines.push(`  ${row.spaceId} ${row.table} ${row.count}`)
  }
  for (const row of report.stuck) {
    lines.push(`stuck ${row.table} ${row.id}${row.reason ? ` ${row.reason}` : ''}`)
  }
  if (report.stuck.length) lines.push(`${PLATFORM_SLUG} record outbox`)
  for (const row of report.unroutable) {
    lines.push(`unroutable ${row.project} ${row.reason} ${row.table}`)
    for (const id of row.ids) lines.push(`  ${id}`)
  }
  lines.push(...unrepairableLines(report.unrepairable))
  if (report.drain) {
    lines.push(
      `drain queued=${report.drain.queued} sent=${report.drain.sent} rejected=${report.drain.rejected} quarantined=${report.drain.quarantined}`,
    )
    lines.push(...drainFailureLines(report.drain))
  }
  return lines.join('\n')
}
