import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import type { TaskIdentity } from './hosted-tasks.ts'

export type HostedSend = {
  id: string
  legacy_local_id: number | null
  at: string
  window: string
  recipients: string
  projects: string
  items: number
  status: 'pending' | 'sent' | 'skipped' | 'failed'
  error: string | null
  test: number
  created_at: string
  machine: string
  subscription_id?: string | null
  period_start?: string | null
  period_end?: string | null
  recipient_details?: HostedSendRecipient[]
}

export type HostedSendRecipient = {
  user_id: string
  name: string
  email: string
}

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
  recipients: HostedReportRecipient[]
  enabled: boolean
  created_at: string
  updated_at: string
}

export type HostedReportRecipient = {
  id: string
  user_id: string
  name: string
  email: string
}

type ReportSubscriptionScopeInput =
  | { kind: 'space' }
  | { kind: 'project'; project: string }
  | { kind: 'person'; userId?: string }

export type ReportSubscriptionWriteInput = {
  scope: ReportSubscriptionScopeInput
  cadence: string
  hour: number
  weekday?: string | null
  zone: string
  recipientUserIds?: string[]
  enabled?: boolean
}

export type ReportSubscriptionUpdateInput = {
  cadence: string
  hour: number
  weekday?: string | null
  zone: string
  enabled: boolean
  scope?: never
}

type PlannedReportSubscription = {
  scope_kind: HostedReportSubscription['scope_kind']
  project_name: string | null
  person_user_id: string | null
  cadence: HostedReportSubscription['cadence']
  hour: number
  weekday: Weekday | null
  zone: string
  recipient_user_ids: string[]
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
    recipients: [],
    enabled: Boolean(Number(row.enabled)),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

export function assertReportSubscriptionFound<T>(row: T | null | undefined): T {
  if (!row) throw new Error('report subscription not found')
  return row
}

function planSubscriptionScope(
  caller: { userId: string },
  scope: ReportSubscriptionScopeInput | undefined,
  projectNames: readonly string[],
): Pick<PlannedReportSubscription, 'scope_kind' | 'project_name' | 'person_user_id'> {
  if (!scope || (scope.kind !== 'space' && scope.kind !== 'project' && scope.kind !== 'person'))
    throw new Error('scope must be space, a project in this space, or yourself')
  if (scope.kind === 'project') {
    const project = scope.project.trim()
    if (!project) throw new Error('project scope requires a project')
    if (!projectNames.includes(project)) throw new Error(`project ${project} is not in this space`)
    return { scope_kind: 'project', project_name: project, person_user_id: null }
  }
  if (scope.kind === 'person') {
    const person = scope.userId ?? caller.userId
    if (person !== caller.userId) throw new Error('person scope must be the calling member')
    return { scope_kind: 'person', project_name: null, person_user_id: person }
  }
  return { scope_kind: 'space', project_name: null, person_user_id: null }
}

function planSubscriptionCadence(
  input: Pick<ReportSubscriptionWriteInput, 'cadence' | 'hour' | 'weekday' | 'zone'>,
): Pick<PlannedReportSubscription, 'cadence' | 'hour' | 'weekday' | 'zone'> {
  if (input.cadence !== 'daily' && input.cadence !== 'weekly')
    throw new Error('cadence must be daily or weekly')
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23)
    throw new Error('hour must be an integer from 0 through 23')
  const weekdayRaw = input.weekday?.trim().toLowerCase() ?? ''
  if (input.cadence === 'daily') {
    if (weekdayRaw) throw new Error('daily cadence does not take a day')
    return cadenceFields('daily', input.hour, null, input.zone)
  }
  if (!WEEKDAYS.includes(weekdayRaw as Weekday))
    throw new Error('weekly cadence requires a day from monday through sunday')
  return cadenceFields('weekly', input.hour, weekdayRaw as Weekday, input.zone)
}

export function planReportSubscriptionUpdate(
  input: ReportSubscriptionUpdateInput & Record<string, unknown>,
): Pick<PlannedReportSubscription, 'cadence' | 'hour' | 'weekday' | 'zone' | 'enabled'> {
  if ('scope' in input || 'recipientUserIds' in input)
    throw new Error('scope cannot be changed; edit recipients separately')
  const editable = new Set(['cadence', 'hour', 'weekday', 'zone', 'enabled'])
  if (Object.keys(input).some((field) => !editable.has(field)))
    throw new Error('only cadence, hour, weekday, zone and enabled can be changed')
  if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false')
  return { ...planSubscriptionCadence(input), enabled: input.enabled }
}

function cadenceFields(
  cadence: PlannedReportSubscription['cadence'],
  hour: number,
  weekday: Weekday | null,
  zoneRaw: string,
) {
  const zone = zoneRaw.trim()
  if (!TIME_ZONES.has(zone)) throw new Error('zone must be an IANA time zone')
  return { cadence, hour, weekday, zone }
}

export function planReportSubscription(
  caller: { userId: string; spaceId: string },
  input: ReportSubscriptionWriteInput,
  facts: { projectNames: readonly string[]; memberUserIds: readonly string[] },
): PlannedReportSubscription {
  const recipientUserIds = [...new Set(input.recipientUserIds ?? [caller.userId])]
  if (recipientUserIds.length === 0) throw new Error('a subscription requires at least one recipient')
  if (recipientUserIds.some((userId) => !facts.memberUserIds.includes(userId)))
    throw new Error('every recipient must be a member of this space')
  return {
    ...planSubscriptionScope(caller, input.scope, facts.projectNames),
    ...planSubscriptionCadence(input),
    recipient_user_ids: recipientUserIds,
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

export async function listHostedSends(
  url: string,
  identity: TaskIdentity,
  filters: { limit?: number; updatedSince?: string; cursor?: string },
) {
  return tenant(url, identity, async (tx) => {
    const since = filters.updatedSince ?? filters.cursor ?? '1970-01-01T00:00:00.000Z'
    const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000))
    const sends = rows<HostedSend & { recipient_details_json: string }>(
      await tx`SELECT id,legacy_local_id,at,"window",recipients,projects,items,status,error,test,
      created_at,machine,subscription_id,period_start,period_end,
      COALESCE((SELECT json_agg(json_build_object('user_id',r.user_id,'name',r.name,'email',r.email)
        ORDER BY r.created_at,r.id) FROM hub_send_recipient r WHERE r.send_id=hub_send.id),'[]')::text
        AS recipient_details_json
      FROM hub_send WHERE space_id=${identity.spaceId}::uuid
      AND created_at > ${since}::timestamptz ORDER BY created_at,id LIMIT ${limit}`,
    )
    const cursor = sends.reduce(
      (latest, row) => (new Date(row.created_at).toISOString() > latest ? row.created_at : latest),
      since,
    )
    return {
      sends: sends.map(({ recipient_details_json, ...send }) => ({
        ...send,
        recipient_details: JSON.parse(recipient_details_json) as HostedSendRecipient[],
      })),
      cursor,
    }
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
      RETURNING id,legacy_local_id,at,"window",recipients,projects,items,status,error,test,created_at,machine,
      subscription_id,period_start,period_end`,
    )[0]!
  })
}

export async function mirrorHostedReports(
  url: string,
  identity: TaskIdentity,
  input: { sends?: HostedSend[] },
) {
  return tenant(url, identity, async (tx) => {
    for (const row of input.sends ?? [])
      await tx`INSERT INTO hub_send
      (id,legacy_local_id,space_id,at,"window",recipients,projects,items,status,error,test,created_at,machine)
      VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.at}::timestamptz,
      ${row.window},${row.recipients},${row.projects},${row.items},${row.status},${row.error},
      ${row.test},${row.created_at}::timestamptz,${row.machine})
      ON CONFLICT(space_id,legacy_local_id) DO NOTHING`
    return { upserted: input.sends?.length ?? 0 }
  })
}

export async function hostedReportCounts(url: string, identity: TaskIdentity) {
  return tenant(url, identity, async (tx) => {
    const result = rows<{ sends: number }>(
      await tx`SELECT
      (SELECT count(*)::int FROM hub_send WHERE space_id=${identity.spaceId}::uuid) sends`,
    )[0]!
    return result
  })
}

const subscriptionSelect = (tx: SQL, spaceId: string, id?: string) => tx`
  SELECT s.id,s.scope_kind,s.project_name,s.person_user_id,s.cadence,s.hour,s.weekday,s.zone,
    s.enabled,s.created_at,s.updated_at
  FROM hub_report_subscription s
  WHERE s.space_id=${spaceId}::uuid AND s.deleted_at IS NULL
    AND (${id ?? null}::uuid IS NULL OR s.id=${id ?? null}::uuid)
  ORDER BY s.created_at,s.id`

export async function selectHostedReportSubscriptions(tx: SQL, spaceId: string) {
  const subscriptions = rows<RawSubscription>(await subscriptionSelect(tx, spaceId)).map(
    asSubscription,
  )
  const recipients = rows<HostedReportRecipient & { subscription_id: string }>(
    await tx`SELECT r.id,r.subscription_id,r.user_id,u.name,u.email
    FROM hub_report_subscription_recipient r JOIN "user" u ON u.id=r.user_id
    WHERE r.space_id=${spaceId}::uuid ORDER BY r.created_at,r.id`,
  )
  const bySubscription = new Map<string, HostedReportRecipient[]>()
  for (const { subscription_id, ...recipient } of recipients) {
    const current = bySubscription.get(subscription_id) ?? []
    current.push(recipient)
    bySubscription.set(subscription_id, current)
  }
  return subscriptions.map((subscription) => ({
    ...subscription,
    recipients: bySubscription.get(subscription.id) ?? [],
  }))
}

async function selectHostedReportSubscription(tx: SQL, spaceId: string, id: string) {
  return assertReportSubscriptionFound(
    (await selectHostedReportSubscriptions(tx, spaceId)).find((row) => row.id === id),
  )
}

export async function listHostedReportSubscriptions(url: string, identity: TaskIdentity) {
  return tenant(url, identity, async (tx) => ({
    subscriptions: await selectHostedReportSubscriptions(tx, identity.spaceId),
  }))
}

export async function createHostedReportSubscription(
  url: string,
  identity: TaskIdentity,
  input: ReportSubscriptionWriteInput,
) {
  return tenant(url, identity, async (tx) => {
    const projects = rows<{ name: string }>(
      await tx`SELECT name FROM project WHERE space_id=${identity.spaceId}::uuid`,
    )
    const members = rows<{ user_id: string }>(
      await tx`SELECT user_id FROM membership WHERE space_id=${identity.spaceId}::uuid`,
    )
    const planned = planReportSubscription(identity, input, {
      projectNames: projects.map((row) => row.name),
      memberUserIds: members.map((row) => row.user_id),
    })
    const id = newRecordId()
    await tx`INSERT INTO hub_report_subscription
      (id,space_id,scope_kind,project_name,person_user_id,cadence,hour,weekday,zone,
       enabled,created_at,updated_at)
      VALUES (${id}::uuid,${identity.spaceId}::uuid,${planned.scope_kind},${planned.project_name},
      ${planned.person_user_id}::uuid,${planned.cadence},${planned.hour},${planned.weekday},
      ${planned.zone},${planned.enabled ? 1 : 0},now(),now())`
    for (const userId of planned.recipient_user_ids)
      await tx`INSERT INTO hub_report_subscription_recipient
        (id,space_id,subscription_id,user_id,created_at)
        VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${id}::uuid,${userId}::uuid,now())`
    return selectHostedReportSubscription(tx, identity.spaceId, id)
  })
}

export async function updateHostedReportSubscription(
  url: string,
  identity: TaskIdentity,
  id: string,
  input: ReportSubscriptionUpdateInput & Record<string, unknown>,
) {
  const planned = planReportSubscriptionUpdate(input)
  return tenant(url, identity, async (tx) => {
    assertReportSubscriptionFound(
      rows<{ id: string }>(
        await tx`UPDATE hub_report_subscription SET cadence=${planned.cadence},hour=${planned.hour},
        weekday=${planned.weekday},zone=${planned.zone},enabled=${planned.enabled ? 1 : 0},
        updated_at=now()
        WHERE space_id=${identity.spaceId}::uuid AND id=${id}::uuid AND deleted_at IS NULL
        RETURNING id`,
      )[0],
    )
    return selectHostedReportSubscription(tx, identity.spaceId, id)
  })
}

export async function addHostedReportSubscriptionRecipient(
  url: string,
  identity: TaskIdentity,
  id: string,
  userId: string,
) {
  return tenant(url, identity, async (tx) => {
    await selectHostedReportSubscription(tx, identity.spaceId, id)
    const member = rows<{ present: number }>(
      await tx`SELECT 1 AS present FROM membership
      WHERE space_id=${identity.spaceId}::uuid AND user_id=${userId}::uuid`,
    )[0]
    if (!member) throw new Error('recipient is not a member of this space')
    await tx`INSERT INTO hub_report_subscription_recipient
      (id,space_id,subscription_id,user_id,created_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${id}::uuid,${userId}::uuid,now())
      ON CONFLICT(subscription_id,user_id) DO NOTHING`
    return selectHostedReportSubscription(tx, identity.spaceId, id)
  })
}

export async function removeHostedReportSubscriptionRecipient(
  url: string,
  identity: TaskIdentity,
  id: string,
  userId: string,
) {
  return tenant(url, identity, async (tx) => {
    await selectHostedReportSubscription(tx, identity.spaceId, id)
    const removed = rows<{ id: string }>(
      await tx`DELETE FROM hub_report_subscription_recipient
      WHERE space_id=${identity.spaceId}::uuid AND subscription_id=${id}::uuid
        AND user_id=${userId}::uuid RETURNING id`,
    )[0]
    if (!removed) throw new Error('report subscription recipient not found')
    return selectHostedReportSubscription(tx, identity.spaceId, id)
  })
}

export async function unsubscribeHostedReportSubscription(
  url: string,
  identity: TaskIdentity,
  id: string,
) {
  return tenant(url, identity, async (tx) => {
    const updated = assertReportSubscriptionFound(
      rows<{ id: string }>(
        await tx`UPDATE hub_report_subscription SET deleted_at=now(),updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND id=${id}::uuid AND deleted_at IS NULL
      RETURNING id`,
      )[0],
    )
    return { id: updated.id, deleted: true }
  })
}
