import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import type { TaskIdentity } from './hosted-tasks.ts'
import type { Report } from './report-types.ts'

export type HostedReportSetting = {
  value: Report
  version: number
  updated_at: string
}

export type HostedSend = {
  id: string
  legacy_local_id: number | null
  at: string
  window: string
  recipients: string
  projects: string
  items: number
  status: 'sent' | 'skipped' | 'failed'
  error: string | null
  test: number
  created_at: string
  machine: string
}

type RawHostedReportSetting = Omit<HostedReportSetting, 'value'> & { value_json: string }
const reportSetting = (row: RawHostedReportSetting | undefined): HostedReportSetting | null =>
  row
    ? {
        value: JSON.parse(row.value_json) as Report,
        version: row.version,
        updated_at: row.updated_at,
      }
    : null

const rows = <T>(value: unknown) => value as T[]
const iso = (value: string | Date) => new Date(value).toISOString()
const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const
type Weekday = (typeof WEEKDAYS)[number]
const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'))

export type HostedReportSubscription = {
  id: string
  scope_kind: 'space' | 'project' | 'person'
  project_name: string | null
  person_user_id: string | null
  cadence: 'daily' | 'weekly'
  hour: number
  weekday: Weekday | null
  zone: string
  recipient_user_id: string
  recipient_name: string
  recipient_email: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export type ReportSubscriptionScopeInput =
  | { kind: 'space' }
  | { kind: 'project'; project: string }
  | { kind: 'person'; userId?: string }

export type ReportSubscriptionWriteInput = {
  scope: ReportSubscriptionScopeInput
  cadence: string
  hour: number
  weekday?: string | null
  zone: string
  recipientUserId?: string
  enabled?: boolean
}

export type PlannedReportSubscription = {
  scope_kind: HostedReportSubscription['scope_kind']
  project_name: string | null
  person_user_id: string | null
  cadence: HostedReportSubscription['cadence']
  hour: number
  weekday: Weekday | null
  zone: string
  recipient_user_id: string
  enabled: boolean
}

type RawSubscription = {
  id: string
  scope_kind: HostedReportSubscription['scope_kind']
  project_name: string | null
  person_user_id: string | null
  cadence: HostedReportSubscription['cadence']
  hour: string | number
  weekday: Weekday | null
  zone: string
  recipient_user_id: string
  recipient_name: string
  recipient_email: string
  enabled: string | number
  created_at: string | Date
  updated_at: string | Date
}

function asSubscription(row: RawSubscription): HostedReportSubscription {
  return {
    id: row.id,
    scope_kind: row.scope_kind,
    project_name: row.project_name,
    person_user_id: row.person_user_id,
    cadence: row.cadence,
    hour: Number(row.hour),
    weekday: row.weekday,
    zone: row.zone,
    recipient_user_id: row.recipient_user_id,
    recipient_name: row.recipient_name,
    recipient_email: row.recipient_email,
    enabled: Boolean(Number(row.enabled)),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

export function assertReportSubscriptionFound<T>(row: T | null | undefined): T {
  if (!row) throw new Error('report subscription not found')
  return row
}

export function planReportSubscription(
  caller: { userId: string; spaceId: string },
  input: ReportSubscriptionWriteInput,
  facts: { projectNames: readonly string[]; memberUserIds: readonly string[] },
): PlannedReportSubscription {
  const scope = input.scope
  if (!scope || (scope.kind !== 'space' && scope.kind !== 'project' && scope.kind !== 'person'))
    throw new Error('scope must be space, a project in this space, or yourself')
  let projectName: string | null = null
  let personUserId: string | null = null
  if (scope.kind === 'project') {
    const project = scope.project.trim()
    if (!project) throw new Error('project scope requires a project')
    if (!facts.projectNames.includes(project))
      throw new Error(`project ${project} is not in this space`)
    projectName = project
  } else if (scope.kind === 'person') {
    const person = scope.userId ?? caller.userId
    if (person !== caller.userId) throw new Error('person scope must be the calling member')
    personUserId = person
  }
  if (input.cadence !== 'daily' && input.cadence !== 'weekly')
    throw new Error('cadence must be daily or weekly')
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23)
    throw new Error('hour must be an integer from 0 through 23')
  const weekdayRaw = input.weekday?.trim().toLowerCase() ?? ''
  let weekday: Weekday | null = null
  if (input.cadence === 'daily') {
    if (weekdayRaw) throw new Error('daily cadence does not take a day')
  } else {
    if (!WEEKDAYS.includes(weekdayRaw as Weekday))
      throw new Error('weekly cadence requires a day from monday through sunday')
    weekday = weekdayRaw as Weekday
  }
  const zone = input.zone.trim()
  if (!TIME_ZONES.has(zone)) throw new Error('zone must be an IANA time zone')
  const recipientUserId = input.recipientUserId ?? caller.userId
  if (!facts.memberUserIds.includes(recipientUserId))
    throw new Error('recipient is not a member of this space')
  return {
    scope_kind: scope.kind,
    project_name: projectName,
    person_user_id: personUserId,
    cadence: input.cadence,
    hour: input.hour,
    weekday,
    zone,
    recipient_user_id: recipientUserId,
    enabled: input.enabled !== false,
  }
}
async function tenant<T>(url: string, identity: TaskIdentity, work: (tx: SQL) => Promise<T>) {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${identity.userId}, true)`
      await tx`SELECT set_config('app.space_id', ${identity.spaceId}, true)`
      return work(tx)
    })
  } finally {
    await client.close()
  }
}

export function assertReportPasswordReference(report: Pick<Report, 'smtpPasswordRef'>) {
  if (report.smtpPasswordRef && !/^(keychain|env):/.test(report.smtpPasswordRef))
    throw new Error(
      'smtpPasswordRef must be "keychain:<service>" or "env:<NAME>", never a password',
    )
}

export function assertReportVersion(current: number | null, supplied: number) {
  const expected = current ?? 0
  if (supplied !== expected)
    throw new Error(`stale report setting version: expected ${expected}, received ${supplied}`)
  return expected + 1
}

export async function getHostedReportSetting(url: string, identity: TaskIdentity) {
  return tenant(url, identity, async (tx) =>
    reportSetting(
      rows<RawHostedReportSetting>(
        await tx`SELECT value::text value_json,version,updated_at FROM hub_report_setting
        WHERE space_id=${identity.spaceId}::uuid`,
      )[0],
    ),
  )
}

export async function putHostedReportSetting(
  url: string,
  identity: TaskIdentity,
  input: { value: Report; version: number },
) {
  assertReportPasswordReference(input.value)
  return tenant(url, identity, async (tx) => {
    const current = rows<{ version: number }>(
      await tx`SELECT version FROM hub_report_setting
      WHERE space_id=${identity.spaceId}::uuid FOR UPDATE`,
    )[0]
    const version = assertReportVersion(current?.version ?? null, input.version)
    const projects = rows<{ name: string }>(
      await tx`SELECT name FROM project WHERE space_id=${identity.spaceId}::uuid`,
    )
    const registered = new Set(projects.map((row) => row.name))
    const value = {
      ...input.value,
      projects: input.value.projects.filter((project) => registered.has(project)),
      to: input.value.to.map((recipient) => recipient.trim()).filter(Boolean),
      briefs: input.value.briefs.filter((brief) => brief?.name && brief.match?.length),
    }
    return reportSetting(
      rows<RawHostedReportSetting>(
        await tx`INSERT INTO hub_report_setting(space_id,value,version,updated_at)
      VALUES (${identity.spaceId}::uuid,${JSON.stringify(value)}::text::jsonb,${version},now())
      ON CONFLICT(space_id) DO UPDATE SET value=excluded.value,version=excluded.version,
      updated_at=excluded.updated_at RETURNING value::text value_json,version,updated_at`,
      )[0],
    )!
  })
}

export async function listHostedSends(
  url: string,
  identity: TaskIdentity,
  filters: { limit?: number; updatedSince?: string; cursor?: string },
) {
  return tenant(url, identity, async (tx) => {
    const since = filters.updatedSince ?? filters.cursor ?? '1970-01-01T00:00:00.000Z'
    const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000))
    const sends = rows<HostedSend>(
      await tx`SELECT id,legacy_local_id,at,"window",recipients,projects,items,status,error,test,
      created_at,machine FROM hub_send WHERE space_id=${identity.spaceId}::uuid
      AND created_at > ${since}::timestamptz ORDER BY created_at,id LIMIT ${limit}`,
    )
    const cursor = sends.reduce(
      (latest, row) => (new Date(row.created_at).toISOString() > latest ? row.created_at : latest),
      since,
    )
    return { sends, cursor }
  })
}

export async function appendHostedSend(
  url: string,
  identity: TaskIdentity,
  input: Omit<HostedSend, 'id' | 'legacy_local_id' | 'created_at'>,
) {
  return tenant(url, identity, async (tx) => {
    return rows<HostedSend>(
      await tx`INSERT INTO hub_send
      (id,space_id,at,"window",recipients,projects,items,status,error,test,created_at,machine)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${input.at}::timestamptz,
      ${input.window},${input.recipients},${input.projects},${input.items},${input.status},
      ${input.error},${input.test},now(),${input.machine})
      RETURNING id,legacy_local_id,at,"window",recipients,projects,items,status,error,test,created_at,machine`,
    )[0]!
  })
}

export async function mirrorHostedReports(
  url: string,
  identity: TaskIdentity,
  input: { setting?: { value: Report; version: number }; sends?: HostedSend[] },
) {
  if (input.setting) assertReportPasswordReference(input.setting.value)
  return tenant(url, identity, async (tx) => {
    if (input.setting) {
      const projects = rows<{ name: string }>(
        await tx`SELECT name FROM project WHERE space_id=${identity.spaceId}::uuid`,
      )
      const registered = new Set(projects.map((row) => row.name))
      const value = {
        ...input.setting.value,
        projects: input.setting.value.projects.filter((project) => registered.has(project)),
      }
      await tx`INSERT INTO hub_report_setting(space_id,value,version,updated_at)
      VALUES (${identity.spaceId}::uuid,${JSON.stringify(value)}::text::jsonb,${input.setting.version},now())
      ON CONFLICT(space_id) DO UPDATE SET value=excluded.value,version=GREATEST(hub_report_setting.version,excluded.version),
      updated_at=CASE WHEN excluded.version >= hub_report_setting.version THEN excluded.updated_at ELSE hub_report_setting.updated_at END`
    }
    for (const row of input.sends ?? [])
      await tx`INSERT INTO hub_send
      (id,legacy_local_id,space_id,at,"window",recipients,projects,items,status,error,test,created_at,machine)
      VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.at}::timestamptz,
      ${row.window},${row.recipients},${row.projects},${row.items},${row.status},${row.error},
      ${row.test},${row.created_at}::timestamptz,${row.machine})
      ON CONFLICT(space_id,legacy_local_id) DO NOTHING`
    return { upserted: (input.setting ? 1 : 0) + (input.sends?.length ?? 0) }
  })
}

export async function hostedReportCounts(url: string, identity: TaskIdentity) {
  return tenant(url, identity, async (tx) => {
    const result = rows<{ setting: number; sends: number }>(
      await tx`SELECT
      (SELECT count(*)::int FROM hub_report_setting WHERE space_id=${identity.spaceId}::uuid) setting,
      (SELECT count(*)::int FROM hub_send WHERE space_id=${identity.spaceId}::uuid) sends`,
    )[0]!
    return result
  })
}
