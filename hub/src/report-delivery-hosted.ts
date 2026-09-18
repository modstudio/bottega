// concern: hosted-report-delivery-adapters
/** PostgreSQL ledger and SES adapters for the hosted report delivery pass. */

import { hostname } from 'node:os'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { hostedMeasures } from './hosted-measures.ts'
import { hostedGatherReport } from './hosted-report-gather.ts'
import { withHostedTenant } from './hosted-tasks.ts'
import type {
  DeliveryCandidate,
  DeliveryPeriod,
  DeliveryRepository,
  DeliveryStatus,
  ReportMailClient,
} from './report-delivery.ts'

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
        ON CONFLICT(subscription_id,period_end) DO NOTHING`
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
    async load(value, period) {
      const loaded = await withHostedTenant(databaseUrl, identity(value), async (tx) => {
        return rows<{
          scope_kind: 'space' | 'project' | 'person'
          project_name: string | null
          person_user_id: string | null
          person_name: string | null
          space_name: string
        }>(
          await tx`SELECT s.scope_kind,s.project_name,s.person_user_id,p.name AS person_name,
            sp.name AS space_name
          FROM hub_report_subscription s
          JOIN space sp ON sp.id=s.space_id
          LEFT JOIN "user" p ON p.id=s.person_user_id
          WHERE s.id=${value.subscriptionId}::uuid AND s.space_id=${value.spaceId}::uuid
            AND s.enabled=1 AND s.deleted_at IS NULL`,
        )[0]
      })
      if (!loaded) throw new Error('report subscription is no longer enabled')
      const recipients = await withHostedTenant(databaseUrl, identity(value), async (tx) =>
        rows<{ user_id: string; name: string; email: string; is_member: number }>(
          await tx`SELECT r.user_id,u.name,u.email,
            CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END AS is_member
          FROM hub_report_subscription_recipient r
          JOIN "user" u ON u.id=r.user_id
          LEFT JOIN membership m ON m.space_id=r.space_id AND m.user_id=r.user_id
          WHERE r.subscription_id=${value.subscriptionId}::uuid
            AND r.space_id=${value.spaceId}::uuid ORDER BY r.created_at,r.id`,
        ).map((row) => ({
          userId: row.user_id,
          name: row.name || row.email,
          email: row.email,
          isMember: Boolean(Number(row.is_member)),
        })),
      )
      const scope =
        loaded.scope_kind === 'project'
          ? ({ kind: 'project', project: loaded.project_name! } as const)
          : loaded.scope_kind === 'person'
            ? ({ kind: 'person', userId: loaded.person_user_id! } as const)
            : ({ kind: 'space' } as const)
      const scopeName =
        loaded.scope_kind === 'project'
          ? loaded.project_name!
          : loaded.scope_kind === 'person'
            ? loaded.person_name || 'Person'
            : loaded.space_name
      const recipientIdentity = identity(value, recipients[0]?.userId)
      const [measures, report] = await Promise.all([
        hostedMeasures(databaseUrl, recipientIdentity, period, scope),
        hostedGatherReport(databaseUrl, recipientIdentity, period, scope),
      ])
      return {
        recipients,
        scope,
        scopeName,
        measures,
        report,
      }
    },
    async recipientsAreMembers(value, recipientUserIds) {
      if (!recipientUserIds.length) return false
      return withHostedTenant(databaseUrl, identity(value, recipientUserIds[0]), async (tx) => {
        const member = rows<{ count: number }>(
          await tx`SELECT count(*)::int AS count FROM membership
          WHERE space_id=${value.spaceId}::uuid AND user_id = ANY(${recipientUserIds}::uuid[])`,
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
          ON CONFLICT(subscription_id,period_end) DO NOTHING RETURNING id`,
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
            },
          },
        }),
      )
    },
  }
}
