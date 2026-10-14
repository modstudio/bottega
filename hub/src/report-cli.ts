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

function reportArgv(subcommand: string, positionals: string[], options: ReportOptions): string[] {
  const argv = ['report', subcommand, ...positionals]
  for (const name of ['cadence', 'day', 'hour', 'project', 'recipient', 'scope', 'zone'] as const) {
    const value = options[name]
    if (value !== undefined) argv.push(`--${name}`, value)
  }
  for (const member of options.member ?? []) argv.push('--member', member)
  if (options.dryRun) argv.push('--dry-run')
  if (options.json) argv.push('--json')
  return argv
}

function registerReportAction(command: Command, subcommand: string): void {
  command.action(async (...args: unknown[]) => {
    requireDatabase()
    const commander = args.at(-1) as Command
    const positionals = args.slice(0, -2).map(String)
    await runReportCommand(reportArgv(subcommand, positionals, commander.opts() as ReportOptions))
  })
}

export function registerReportCommands(program: Command): void {
  const report = program.command('report').description('manage scheduled reports')
  const subscribe = report
    .command('subscribe')
    .option('--scope <space|project|person>', '')
    .option('--project <name>', '')
    .option('--member <user-id>', '', repeat, [])
    .option('--cadence <daily|weekly>', '')
    .option('--hour <N>', '')
    .option('--day <monday>', '')
    .option('--zone <area/city>', '')
    .option('--recipient <user-id>', '')
  registerReportAction(subscribe, 'subscribe')
  const subscriptions = report.command('subscriptions').option('--json', '')
  registerReportAction(subscriptions, 'subscriptions')
  registerReportAction(report.command('unsubscribe <id>'), 'unsubscribe')
  const send = report
    .command('send')
    .description('render and send every subscription whose period is due')
    .option('--dry-run', '')
  registerReportAction(send, 'send')
  const push = report
    .command('push')
    .description('migrate and verify send history')
    .option('--dry-run', '')
  registerReportAction(push, 'push')
}

function flagOf(argv: string[], name: string) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

function flagsOf(argv: string[], name: string) {
  return argv.flatMap((value, index) =>
    value === `--${name}` && argv[index + 1] ? [argv[index + 1]!] : [],
  )
}

async function reportPush(dryRun: boolean) {
  const result = await pushReports({ dryRun })
  console.log(JSON.stringify(result, null, 2))
  if (result.match === false) process.exitCode = 1
}

function subscriptionScope(
  row: Awaited<ReturnType<typeof hostedListReportSubscriptions>>['subscriptions'][number],
) {
  if (row.scope_kind === 'project') return `project ${row.project_name}`
  if (row.scope_kind === 'members')
    return `members ${row.members.map((member) => member.user_id).join(',')}`
  if (row.scope_kind === 'projects')
    return `projects ${row.projects.map((project) => `${project.space_name}/${project.project_name}`).join(',')}`
  return 'space'
}

async function reportList(json: boolean) {
  const { subscriptions } = await hostedListReportSubscriptions()
  if (json) {
    console.log(JSON.stringify(subscriptions))
    return
  }
  if (!subscriptions.length) {
    console.log('no report subscriptions')
    return
  }
  for (const row of subscriptions) {
    const scope = subscriptionScope(row)
    const when =
      row.cadence === 'weekly'
        ? `weekly ${row.weekday} ${row.hour}:00 ${row.zone}`
        : `daily ${row.hour}:00 ${row.zone}`
    console.log(
      `${row.id}  ${scope}  ${when}  ${row.recipients.map((recipient) => recipient.email).join(', ') || 'no recipients'}  ${row.enabled ? 'enabled' : 'disabled'}`,
    )
  }
}

function subscribeScope(argv: string[]) {
  const kind = flagOf(argv, 'scope')
  if (kind === 'space') return { kind: 'space' as const }
  if (kind === 'project')
    return { kind: 'project' as const, project: flagOf(argv, 'project') ?? '' }
  if (kind === 'members') return { kind: 'members' as const, userIds: flagsOf(argv, 'member') }
  throw new Error(
    'usage: hub report subscribe --scope space|project|members [--project NAME] [--member USER_ID] --cadence daily|weekly --hour N [--day monday] --zone AREA/CITY [--recipient USER_ID]',
  )
}

async function reportSubscribe(argv: string[]) {
  const hour = Number(flagOf(argv, 'hour'))
  const row = await hostedCreateReportSubscription({
    scope: subscribeScope(argv),
    cadence: flagOf(argv, 'cadence') ?? '',
    hour: Number.isFinite(hour) ? hour : Number.NaN,
    weekday: flagOf(argv, 'day'),
    zone: flagOf(argv, 'zone') ?? '',
    recipientUserIds: flagOf(argv, 'recipient') ? [flagOf(argv, 'recipient')!] : undefined,
  })
  console.log(row.id)
}

async function reportUnsubscribe(id: string | undefined) {
  if (!id || id.startsWith('--')) throw new Error('usage: hub report unsubscribe <ID>')
  const row = await hostedUnsubscribeReportSubscription(id)
  console.log(`unsubscribed ${row.id}`)
}

export async function runReportCommand(argv: string[]) {
  const sub = argv[1]
  if (sub === 'push') return reportPush(argv.includes('--dry-run'))
  if (sub === 'subscriptions') return reportList(argv.includes('--json'))
  if (sub === 'subscribe') return reportSubscribe(argv)
  if (sub === 'unsubscribe') return reportUnsubscribe(argv[2])
  if (sub === 'send') return runReportDeliveryCommand(argv)
  throw new Error('usage: hub report subscribe|subscriptions|unsubscribe|push|send')
}
import type { Command } from 'commander'
import { requireDatabase } from './db.ts'
