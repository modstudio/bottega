// concern: hosted-report-delivery-adapters
/** PostgreSQL ledger and SES adapters for the hosted report delivery pass. */

import { hostname } from 'node:os'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { hostedMeasures } from './hosted-measures.ts'
import { gatherHostedReport, hostedGatherReport } from './hosted-report-gather.ts'
import { withHostedTenant } from './hosted-tasks.ts'
import { computeMeasures } from './measures.ts'
import type {
  DeliveryCandidate,
  DeliveryPeriod,
  DeliveryRepository,
  DeliveryStatus,
  ReportMailClient,
} from './report-delivery.ts'
import { renderReport } from './report-delivery.ts'

type Environment = Record<string, string | undefined>
type SesPort = { send(command: SendEmailCommand): Promise<unknown> }
const rows = <T>(value: unknown) => value as T[]
const iso = (value: string | Date | null) => (value == null ? null : new Date(value).toISOString())

type RawCandidate = {
  subscription_id: string
  space_id: string
  cadence: 'daily' | 'weekly'
  hour: number
  weekday: string | null
  zone: string
  created_at: string | Date
  last_period_end: string | Date | null
}

function candidate(row: RawCandidate): DeliveryCandidate {
  return {
    subscriptionId: row.subscription_id,
    spaceId: row.space_id,
    cadence: row.cadence,
    hour: Number(row.hour),
    weekday: row.weekday,
    zone: row.zone,
    createdAt: iso(row.created_at)!,
    lastPeriodEnd: iso(row.last_period_end),
  }
}

function identity(value: DeliveryCandidate, userId = '00000000-0000-0000-0000-000000000000') {
  return { spaceId: value.spaceId, userId }
}

export function hostedDeliveryRepository(databaseUrl: string): DeliveryRepository {
  async function insertFinal(
    value: DeliveryCandidate,
    period: DeliveryPeriod,
    input: { status: DeliveryStatus; reason: string; recipients?: string; items?: number },
  ) {
    await withHostedTenant(databaseUrl, identity(value), async (tx) => {
      await tx`INSERT INTO hub_send
        (id,space_id,at,"window",recipients,projects,items,status,error,test,created_at,machine,
         subscription_id,period_start,period_end)
        VALUES (${newRecordId()}::uuid,${value.spaceId}::uuid,now(),
        ${`${period.from}/${period.to}`},${input.recipients ?? 'recipient unavailable'},'subscription',
        ${input.items ?? 0},${input.status},${input.reason},0,now(),${hostname()},
        ${value.subscriptionId}::uuid,${period.from}::timestamptz,${period.to}::timestamptz)
        ON CONFLICT(subscription_id,period_end) WHERE test=0 DO NOTHING`
    })
  }

  return {
    async discover() {
      const client = new SQL(databaseUrl)
      try {
        return rows<RawCandidate>(await client`SELECT * FROM hub_report_delivery_candidates()`).map(
          candidate,
        )
      } finally {
        await client.close()
      }
    },
    async load(value, period, options) {
      const loaded = await withHostedTenant(databaseUrl, identity(value), async (tx) => {
        return rows<{
          scope_kind: 'space' | 'project' | 'members' | 'projects'
          project_name: string | null
          member_ids: string[]
          member_names: string[]
          space_name: string
          owner_user_id: string | null
        }>(
          await tx`SELECT s.scope_kind,s.project_name,sp.name AS space_name,owner.id AS owner_user_id,
            COALESCE(array_agg(m.user_id ORDER BY m.created_at,m.id)
              FILTER (WHERE m.user_id IS NOT NULL),'{}') AS member_ids,
            COALESCE(array_agg(COALESCE(NULLIF(u.name,''),u.email) ORDER BY m.created_at,m.id)
              FILTER (WHERE m.user_id IS NOT NULL),'{}') AS member_names
          FROM hub_report_subscription s
          JOIN space sp ON sp.id=s.space_id
          LEFT JOIN "user" owner ON owner.personal_space_id=s.space_id
          LEFT JOIN hub_report_subscription_member m ON m.subscription_id=s.id AND m.space_id=s.space_id
          LEFT JOIN "user" u ON u.id=m.user_id
          WHERE s.id=${value.subscriptionId}::uuid AND s.space_id=${value.spaceId}::uuid
            AND (${options?.includeDisabled ?? false} OR s.enabled=1) AND s.deleted_at IS NULL
          GROUP BY s.id,sp.name,owner.id`,
        )[0]
      })
      if (!loaded) throw new Error('report subscription is no longer enabled')
      const ownerUserId = loaded.owner_user_id ?? identity(value).userId
      const ownerSpaces = await withHostedTenant(
        databaseUrl,
        identity(value, ownerUserId),
        async (tx) =>
          rows<{ space_id: string }>(
            await tx`SELECT DISTINCT project_space_id AS space_id
              FROM hub_report_subscription_project
              WHERE subscription_id=${value.subscriptionId}::uuid AND space_id=${value.spaceId}::uuid`,
          ).map((row) => row.space_id),
      )
      const deliveryIdentity = {
        spaceId: value.spaceId,
        userId: ownerUserId,
        spaceIds: ownerSpaces,
      }
      const recipients = await withHostedTenant(databaseUrl, deliveryIdentity, async (tx) =>
        rows<{
          user_id: string | null
          name: string
          email: string
          is_member: number
          unsubscribe_token: string | null
        }>(
          await tx`SELECT r.user_id,COALESCE(u.name,r.email) AS name,COALESCE(u.email,r.email) AS email,
            CASE WHEN r.user_id IS NULL OR m.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_member,
            r.unsubscribe_token
          FROM hub_report_subscription_recipient r
          LEFT JOIN "user" u ON u.id=r.user_id
          LEFT JOIN membership m ON m.space_id=r.space_id AND m.user_id=r.user_id
          WHERE r.subscription_id=${value.subscriptionId}::uuid
            AND r.space_id=${value.spaceId}::uuid ORDER BY r.created_at,r.id`,
        ).map((row) => ({
          userId: row.user_id,
          name: row.name || row.email,
          email: row.email,
          isMember: Boolean(Number(row.is_member)),
          unsubscribeToken: row.unsubscribe_token,
        })),
      )
      const selectedProjects =
        loaded.scope_kind === 'projects'
          ? await withHostedTenant(databaseUrl, deliveryIdentity, async (tx) =>
              rows<{
                project_id: string
                project_name: string | null
                snapshot_name: string
                space_id: string | null
                snapshot_space_id: string
                space_name: string | null
                role: string | null
                retired_at: string | Date | null
              }>(
                await tx`SELECT x.project_id,p.name AS project_name,x.project_name AS snapshot_name,
                  p.space_id,x.project_space_id AS snapshot_space_id,sp.name AS space_name,
                  m.role,p.retired_at
                FROM hub_report_subscription_project x
                LEFT JOIN project p ON p.id=x.project_id
                LEFT JOIN space sp ON sp.id=x.project_space_id
                LEFT JOIN membership m ON m.space_id=x.project_space_id AND m.user_id=${ownerUserId}::uuid
                WHERE x.subscription_id=${value.subscriptionId}::uuid AND x.space_id=${value.spaceId}::uuid
                ORDER BY sp.name,p.name,p.id`,
              ),
            )
          : []
      const validProjects = selectedProjects.filter(
        (project) =>
          project.project_name &&
          project.space_id &&
          project.space_name &&
          !project.retired_at &&
          (project.role === 'owner' || project.role === 'admin'),
      )
      const exclusions = selectedProjects.flatMap((project) => {
        const name = `${project.space_name ?? project.snapshot_space_id}/${project.snapshot_name}`
        if (!project.project_name || project.retired_at) return [`${name}: project was deleted`]
        if (project.role !== 'owner' && project.role !== 'admin')
          return [`${name}: subscription owner is no longer an owner or admin`]
        return []
      })
      const scope =
        loaded.scope_kind === 'project'
          ? ({ kind: 'project', project: loaded.project_name! } as const)
          : loaded.scope_kind === 'members'
            ? ({ kind: 'members', userIds: loaded.member_ids } as const)
            : loaded.scope_kind === 'projects'
              ? ({
                  kind: 'projects',
                  projectIds: validProjects.map((row) => row.project_id),
                } as const)
              : ({ kind: 'space' } as const)
      const scopeName =
        loaded.scope_kind === 'project'
          ? loaded.project_name!
          : loaded.scope_kind === 'members'
            ? loaded.member_names.join(', ')
            : loaded.scope_kind === 'projects'
              ? 'Selected projects'
              : loaded.space_name
      const recipientIdentity =
        loaded.scope_kind === 'projects'
          ? {
              ...deliveryIdentity,
              spaceIds: [...new Set(validProjects.map((project) => project.space_id!))],
            }
          : identity(value, recipients.find((recipient) => recipient.userId)?.userId ?? undefined)
      if (loaded.scope_kind === 'projects' && validProjects.length === 0) {
        return {
          recipients,
          scope,
          scopeName,
          measures: computeMeasures({ intervals: [], events: [] }, period, { kind: 'space' }),
          report: gatherHostedReport([], new Set(), period),
          exclusions,
          unavailableReason: exclusions.join('\n') || 'subscription has no chosen projects',
        }
      }
      const [measures, report] = await Promise.all([
        hostedMeasures(databaseUrl, recipientIdentity, period, scope),
        hostedGatherReport(databaseUrl, recipientIdentity, period, scope),
      ])
      const sectionGroups = new Map<string, typeof validProjects>()
      for (const project of validProjects) {
        const current = sectionGroups.get(project.space_id!) ?? []
        current.push(project)
        sectionGroups.set(project.space_id!, current)
      }
      const sections =
        loaded.scope_kind === 'projects'
          ? await Promise.all(
              [...sectionGroups.values()].map(async (projects) => {
                const sectionScope = {
                  kind: 'projects' as const,
                  projectIds: projects.map((row) => row.project_id),
                }
                const [sectionMeasures, sectionReport] = await Promise.all([
                  hostedMeasures(databaseUrl, recipientIdentity, period, sectionScope),
                  hostedGatherReport(databaseUrl, recipientIdentity, period, sectionScope),
                ])
                return {
                  name: projects[0]!.space_name!,
                  measures: sectionMeasures,
                  report: sectionReport,
                }
              }),
            )
          : undefined
      return {
        recipients,
        scope,
        scopeName,
        measures,
        report,
        sections,
        exclusions,
      }
    },
    async recipientsAreMembers(value, recipientUserIds) {
      if (!recipientUserIds.length) return true
      return withHostedTenant(databaseUrl, identity(value, recipientUserIds[0]), async (tx) => {
        const member = rows<{ count: number }>(
          await tx`SELECT count(*)::int AS count FROM membership
          WHERE space_id=${value.spaceId}::uuid
            AND user_id = ANY(${tx.array(recipientUserIds, 'uuid')})`,
        )[0]!
        return Number(member.count) === recipientUserIds.length
      })
    },
    recordFinal: insertFinal,
    async recordIntent(value, period, input) {
      return withHostedTenant(databaseUrl, identity(value), async (tx) => {
        const id = newRecordId()
        const inserted = rows<{ id: string }>(
          await tx`INSERT INTO hub_send
          (id,space_id,at,"window",recipients,projects,items,status,error,test,created_at,machine,
           subscription_id,period_start,period_end)
          VALUES (${id}::uuid,${value.spaceId}::uuid,now(),${`${period.from}/${period.to}`},
          ${input.recipients.map((recipient) => recipient.email).join(', ')},'subscription',${input.items},'pending',NULL,0,now(),${hostname()},
          ${value.subscriptionId}::uuid,${period.from}::timestamptz,${period.to}::timestamptz)
          ON CONFLICT(subscription_id,period_end) WHERE test=0 DO NOTHING RETURNING id`,
        )[0]
        if (!inserted) return null
        for (const recipient of input.recipients)
          await tx`INSERT INTO hub_send_recipient
            (id,space_id,send_id,user_id,name,email,created_at)
            VALUES (${newRecordId()}::uuid,${value.spaceId}::uuid,${inserted.id}::uuid,
            ${recipient.userId}::uuid,${recipient.name},${recipient.email},now())`
        return inserted.id
      })
    },
    async recordOutcome(value, intentId, status, reason) {
      await withHostedTenant(databaseUrl, identity(value), async (tx) => {
        const updated = rows<{ id: string }>(
          await tx`UPDATE hub_send SET status=${status},error=${reason ?? null},at=now()
          WHERE id=${intentId}::uuid AND subscription_id=${value.subscriptionId}::uuid
          RETURNING id`,
        )[0]
        if (!updated) throw new Error(`send intent ${intentId} was not found`)
      })
    },
  }
}

const TEST_REFUSAL = 'report mailer refuses a real SES client under the test runner'
const TEST_SEND_COOLDOWN_SECONDS = 60

function required(environment: Environment, name: string) {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required to send report email`)
  return value
}

export function sesReportMailClient(
  environment: Environment = process.env,
  injectedClient?: SesPort,
): ReportMailClient {
  return {
    async send(input) {
      if (process.env.NODE_ENV === 'test' && !injectedClient) throw new Error(TEST_REFUSAL)
      const region = required(environment, 'SES_REGION')
      const from = required(environment, 'SES_FROM_ADDRESS')
      const accessKeyId = required(environment, 'SES_ACCESS_KEY_ID')
      const secretAccessKey = required(environment, 'SES_SECRET_ACCESS_KEY')
      const client =
        injectedClient ?? new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } })
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: input.to },
          Content: {
            Simple: {
              Subject: { Data: input.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: input.text, Charset: 'UTF-8' },
                Html: { Data: input.html, Charset: 'UTF-8' },
              },
              Headers: input.headers?.map((header) => ({
                Name: header.name,
                Value: header.value,
              })),
            },
          },
        }),
      )
    },
  }
}

export async function sendHostedReportSubscriptionTest(
  databaseUrl: string,
  caller: { spaceId: string; userId: string },
  subscriptionId: string,
  options: { now?: Date; mail?: ReportMailClient } = {},
) {
  const now = options.now ?? new Date()
  const loaded = await withHostedTenant(
    databaseUrl,
    caller,
    async (tx) =>
      rows<{
        cadence: 'daily' | 'weekly'
        hour: number
        weekday: string | null
        zone: string
        created_at: string | Date
        name: string
        email: string
      }>(
        await tx`SELECT s.cadence,s.hour,s.weekday,s.zone,s.created_at,u.name,u.email
      FROM hub_report_subscription s JOIN "user" u ON u.id=${caller.userId}::uuid
      WHERE s.id=${subscriptionId}::uuid AND s.space_id=${caller.spaceId}::uuid
        AND s.deleted_at IS NULL`,
      )[0],
  )
  if (!loaded) throw new Error('report subscription not found')
  const candidate: DeliveryCandidate = {
    subscriptionId,
    spaceId: caller.spaceId,
    cadence: loaded.cadence,
    hour: Number(loaded.hour),
    weekday: loaded.weekday,
    zone: loaded.zone,
    createdAt: iso(loaded.created_at)!,
    lastPeriodEnd: null,
  }
  const to = now.toISOString()
  const period: DeliveryPeriod = {
    from: new Date(
      now.getTime() - (loaded.cadence === 'daily' ? 24 : 168) * 3_600_000,
    ).toISOString(),
    to,
    key: to,
  }
  const sendId = newRecordId()
  await withHostedTenant(databaseUrl, caller, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${subscriptionId}))`
    const recent = rows<{ id: string }>(
      await tx`SELECT id FROM hub_send WHERE subscription_id=${subscriptionId}::uuid AND test=1
        AND created_at > now() - make_interval(secs => ${TEST_SEND_COOLDOWN_SECONDS})`,
    )[0]
    if (recent)
      throw new Error(
        `a test was sent for this subscription less than ${TEST_SEND_COOLDOWN_SECONDS} seconds ago; wait and try again`,
      )
    await tx`INSERT INTO hub_send
      (id,space_id,at,"window",recipients,projects,items,status,error,test,created_at,machine,
       subscription_id,period_start,period_end)
      VALUES (${sendId}::uuid,${caller.spaceId}::uuid,now(),${`${period.from}/${period.to}`},
      ${loaded.email},'subscription',0,'pending',NULL,1,now(),${hostname()},
      ${subscriptionId}::uuid,${period.from}::timestamptz,${period.to}::timestamptz)`
    await tx`INSERT INTO hub_send_recipient
      (id,space_id,send_id,user_id,name,email,created_at)
      VALUES (${newRecordId()}::uuid,${caller.spaceId}::uuid,${sendId}::uuid,
      ${caller.userId}::uuid,${loaded.name || loaded.email},${loaded.email},now())`
  })
  try {
    const subscription = await hostedDeliveryRepository(databaseUrl).load(candidate, period, {
      includeDisabled: true,
    })
    const rendered = renderReport(candidate, period, {
      ...subscription,
      recipients: [
        {
          userId: caller.userId,
          name: loaded.name || loaded.email,
          email: loaded.email,
          isMember: true,
        },
      ],
    })
    await (options.mail ?? sesReportMailClient()).send({ ...rendered, to: [loaded.email] })
    await withHostedTenant(databaseUrl, caller, async (tx) => {
      await tx`UPDATE hub_send SET status='sent',items=${subscription.report.items.length},at=now()
        WHERE id=${sendId}::uuid`
    })
    return { id: sendId, status: 'sent' as const, email: loaded.email }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    await withHostedTenant(databaseUrl, caller, async (tx) => {
      await tx`UPDATE hub_send SET status='failed',error=${reason},at=now() WHERE id=${sendId}::uuid`
    })
    throw new Error(reason)
  }
}
