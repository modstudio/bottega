import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { requireDatabase } from './db.ts'
import {
  hostedCreateReportSubscription,
  hostedListReportSubscriptions,
  hostedUnsubscribeReportSubscription,
} from './report-client.ts'
import { runReportDeliveryCommand } from './report-delivery-cli.ts'
import { pushReports } from './report-push.ts'

type ReportOptions = {
  cadence?: string
  day?: string
  dryRun?: boolean
  hour?: string
  json?: boolean
  member?: string[]
  project?: string
  recipient?: string
  scope?: string
  zone?: string
}

const repeat = (value: string, previous: string[] = []) => [...previous, value]
const open = () => requireDatabase()

async function reportPush(dryRun: boolean): Promise<void> {
  const result = await pushReports({ dryRun })
  console.log(JSON.stringify(result, null, 2))
  if (result.match === false) process.exitCode = 1
}

function subscriptionScope(
  row: Awaited<ReturnType<typeof hostedListReportSubscriptions>>['subscriptions'][number],
): string {
  if (row.scope_kind === 'project') return `project ${row.project_name}`
  if (row.scope_kind === 'members')
    return `members ${row.members.map((member) => member.user_id).join(',')}`
  if (row.scope_kind === 'projects')
    return `projects ${row.projects.map((project) => `${project.space_name}/${project.project_name}`).join(',')}`
  return 'space'
}

async function reportList(json: boolean): Promise<void> {
  const { subscriptions } = await hostedListReportSubscriptions()
  if (json) console.log(JSON.stringify(subscriptions))
  else if (!subscriptions.length) console.log('no report subscriptions')
  else
    for (const row of subscriptions) {
      const when =
        row.cadence === 'weekly'
          ? `weekly ${row.weekday} ${row.hour}:00 ${row.zone}`
          : `daily ${row.hour}:00 ${row.zone}`
      console.log(
        `${row.id}  ${subscriptionScope(row)}  ${when}  ` +
          `${row.recipients.map((recipient) => recipient.email).join(', ') || 'no recipients'}  ` +
          `${row.enabled ? 'enabled' : 'disabled'}`,
      )
    }
}

function subscribeScope(options: ReportOptions) {
  if (options.scope === 'space') return { kind: 'space' as const }
  if (options.scope === 'project')
    return { kind: 'project' as const, project: options.project ?? '' }
  if (options.scope === 'members')
    return { kind: 'members' as const, userIds: options.member ?? [] }
  throw new Error(
    `usage: ${PLATFORM_SLUG} report subscribe --scope space|project|members [--project NAME] [--member USER_ID] --cadence daily|weekly --hour N [--day monday] --zone AREA/CITY [--recipient USER_ID]`,
  )
}

async function reportSubscribe(options: ReportOptions): Promise<void> {
  const hour = Number(options.hour)
  const row = await hostedCreateReportSubscription({
    scope: subscribeScope(options),
    cadence: options.cadence ?? '',
    hour: Number.isFinite(hour) ? hour : Number.NaN,
    weekday: options.day,
    zone: options.zone ?? '',
    recipientUserIds: options.recipient ? [options.recipient] : undefined,
  })
  console.log(row.id)
}

export function registerReportCommands(program: Command): void {
  const report = program
    .command('report')
    .description('manage scheduled reports')
    .action(() => {
      open()
      throw new Error(
        `usage: ${PLATFORM_SLUG} report subscribe|subscriptions|unsubscribe|push|send`,
      )
    })
  report
    .command('subscribe')
    .description('create a scheduled report subscription')
    .option('--scope <space|project|person>', 'scope covered by the report')
    .option('--project <name>', 'project covered by a project report')
    .option('--member <user-id>', 'member covered by a members report', repeat, [])
    .option('--cadence <daily|weekly>', 'delivery cadence for the report')
    .option('--hour <N>', 'local hour when the report is due')
    .option('--day <monday>', 'weekday when a weekly report is due')
    .option('--zone <area/city>', 'time zone used to schedule delivery')
    .option('--recipient <user-id>', 'member who receives the report')
    .action(async (options: ReportOptions) => {
      open()
      await reportSubscribe(options)
    })
  report
    .command('subscriptions')
    .description('list report subscriptions')
    .option('--json', 'write the subscriptions as JSON')
    .action(async (options: ReportOptions) => {
      open()
      await reportList(Boolean(options.json))
    })
  report
    .command('unsubscribe <id>')
    .description('remove a report subscription')
    .action(async (id) => {
      open()
      const row = await hostedUnsubscribeReportSubscription(id)
      console.log(`unsubscribed ${row.id}`)
    })
  report
    .command('send')
    .description('render and send every subscription whose period is due')
    .option('--dry-run', 'render due reports without sending them')
    .action(async (options: ReportOptions) => {
      open()
      await runReportDeliveryCommand({ dryRun: Boolean(options.dryRun) })
    })
  report
    .command('push')
    .description('migrate and verify send history')
    .option('--dry-run', 'compare send history without writing it')
    .action(async (options: ReportOptions) => {
      open()
      await reportPush(Boolean(options.dryRun))
    })
}
