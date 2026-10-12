import { db, writeTransaction } from './db.ts'
import { rememberHostedInstall } from './install-binding.ts'
import { drainHostedOutbox, type HostedOutboxReport, queueHostedChange } from './outbox.ts'
import { projects } from './projects.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DAY_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
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
  compareIdentitySets,
  type IdentitySetComparison,
  identitySetAgrees,
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

type TableAudit = IdentitySetComparison & { table: PushableHubChangeTable }
type SpaceAudit = { spaceId: string; tables: TableAudit[] }
type UnroutableRows = {
  project: string
  reason: string
  table: PushableHubChangeTable
  ids: string[]
}
export type TaskPushReport = {
  spaces: SpaceAudit[]
  unroutable: UnroutableRows[]
  drain: HostedOutboxReport | null
  ok: boolean
}

const EVIDENCE_TABLES = new Set<string>([HOSTED_INTERVAL_TABLE, HOSTED_DAY_TABLE])

function machineRowsFor(table: PushableHubChangeTable): MachineRow[] {
  if (table === HOSTED_TASK_TABLE)
    return db()
      .query<MachineRow, []>(
        `SELECT record_id id, project project_name FROM task WHERE record_id IS NOT NULL`,
      )
      .all()
  if (table === HOSTED_COMMENT_TABLE)
    return db()
      .query<MachineRow, []>(
        `SELECT c.record_id id, t.project project_name FROM task_comment c
         JOIN task t ON t.record_id=c.task_record_id WHERE c.record_id IS NOT NULL`,
      )
      .all()
  if (table === HOSTED_DOCUMENT_TABLE)
    return db()
      .query<MachineRow, []>(
        `SELECT d.record_id id, t.project project_name FROM task_document d
         JOIN task t ON t.record_id=d.task_record_id WHERE d.record_id IS NOT NULL`,
      )
      .all()
  if (table === HOSTED_STATUS_EVENT_TABLE)
    return db()
      .query<MachineRow, []>(
        `SELECT e.record_id id, t.project project_name FROM task_status_event e
         JOIN task t ON t.record_id=e.task_record_id WHERE e.record_id IS NOT NULL`,
      )
      .all()
  if (table === HOSTED_INTERVAL_TABLE)
    return db()
      .query<MachineRow, []>(
        `SELECT record_id id, project project_name FROM interval WHERE record_id IS NOT NULL`,
      )
      .all()
  return db()
    .query<MachineRow, []>(
      `SELECT record_id id, NULL project_name FROM day WHERE record_id IS NOT NULL`,
    )
    .all()
}

function inFlightIds(table: PushableHubChangeTable): Set<string> {
  return new Set(
    db()
      .query<{ row_id: string }, [string]>(`SELECT row_id FROM hosted_outbox WHERE table_name=?`)
      .all(table)
      .map((row) => row.row_id),
  )
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

function queueMachineOnly(table: PushableHubChangeTable, ids: readonly string[]) {
  if (!ids.length) return
  writeTransaction((conn) => {
    for (const id of ids) queueHostedChange(conn, table, id, 'upsert')
  })
}

async function auditTable(
  table: PushableHubChangeTable,
  spaces: readonly string[],
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
  listIds: typeof hostedIdentitySet,
  requestOptions: RequestOptions,
) {
  const partitioned = partitionProjectRows(machineRowsFor(table), registered, identity)
  const unroutable: UnroutableRows[] = [...partitioned.refusals].map(([project, refusal]) => ({
    project,
    reason: refusal.reason,
    table,
    ids: refusal.rows.map((row) => row.id).sort(),
  }))
  const audits: Array<{ spaceId: string; audit: TableAudit }> = []
  const missing: string[] = []
  for (const spaceId of spaces) {
    const machineIds = (partitioned.destinations.get(spaceId) ?? []).map((row) => row.id)
    const hostedIds = await hostedIdsFor(table, spaceId, listIds, requestOptions)
    const audit = {
      table,
      ...compareIdentitySets(machineIds, hostedIds, inFlightIds(table)),
    }
    audits.push({ spaceId, audit })
    missing.push(...audit.machineOnly)
  }
  return { unroutable, audits, missing }
}

export async function pushTasks(options: Options = {}): Promise<TaskPushReport> {
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await (options.identity ?? hostedTaskIdentity)(requestOptions)
  assertSpaceIdentitySet(identity)
  rememberHostedInstall(identity.activeSpaceId)
  const registered = (options.registered ?? projects)()
  const listIds = options.listIds ?? hostedIdentitySet
  const spaces = taskPullSpaces(registered, identity)
  const bySpace = new Map<string, TableAudit[]>(spaces.map((spaceId) => [spaceId, []]))
  const unroutable: UnroutableRows[] = []
  const missingByTable = new Map<PushableHubChangeTable, string[]>()
  for (const table of PUSHABLE_HUB_CHANGE_TABLES) {
    const result = await auditTable(table, spaces, registered, identity, listIds, requestOptions)
    unroutable.push(...result.unroutable)
    missingByTable.set(table, result.missing)
    for (const { spaceId, audit } of result.audits) bySpace.get(spaceId)!.push(audit)
  }
  const reportSpaces: SpaceAudit[] = [...bySpace].map(([spaceId, tables]) => ({ spaceId, tables }))
  const ok =
    unroutable.length === 0 &&
    reportSpaces.every((space) => space.tables.every((table) => identitySetAgrees(table)))
  if (!options.repair) return { spaces: reportSpaces, unroutable, drain: null, ok }
  for (const table of PUSHABLE_HUB_CHANGE_TABLES)
    queueMachineOnly(table, missingByTable.get(table) ?? [])
  const drain = await (options.drain ?? drainHostedOutbox)({
    identity: async () => identity,
    registered: () => registered,
    push: (changes, pushOptions) =>
      hostedPushChanges(changes, { ...requestOptions, ...pushOptions }),
  })
  return { spaces: reportSpaces, unroutable, drain, ok }
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
  const hostedTaskFamily = report.spaces.flatMap((space) =>
    space.tables
      .filter((table) => !EVIDENCE_TABLES.has(table.table))
      .map((table) => ({ spaceId: space.spaceId, table: table.table, ids: table.hostedOnly })),
  )
  const hostedEvidence = report.spaces.flatMap((space) =>
    space.tables
      .filter((table) => EVIDENCE_TABLES.has(table.table))
      .map((table) => ({ spaceId: space.spaceId, table: table.table, ids: table.hostedOnly })),
  )
  const familyLines = idLines('Only on the hosted record', hostedTaskFamily)
  if (familyLines.length) {
    lines.push(...familyLines)
    lines.push('The machine has no command to fetch them yet.')
  }
  const evidenceLines = idLines('Only on the hosted record', hostedEvidence)
  if (evidenceLines.length) {
    lines.push(...evidenceLines)
    lines.push(
      'These are rows the machine no longer holds, since the machine is their only writer.',
    )
    lines.push('The machine has no command to fetch them yet.')
  }
  for (const row of report.unroutable)
    lines.push(`unroutable ${row.project} ${row.reason} ${row.table} ${row.ids.length}`)
  if (report.drain)
    lines.push(
      `drain queued=${report.drain.queued} sent=${report.drain.sent} rejected=${report.drain.rejected} quarantined=${report.drain.quarantined}`,
    )
  return lines.join('\n')
}
