import {
  hostedCreateReportSubscription,
  hostedListReportSubscriptions,
  hostedUnsubscribeReportSubscription,
} from './report-client.ts'
import { runReportDeliveryCommand } from './report-delivery-cli.ts'
import { pushReports } from './report-push.ts'

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
    const scope =
      row.scope_kind === 'project'
        ? `project ${row.project_name}`
        : row.scope_kind === 'members'
          ? `members ${row.members.map((member) => member.user_id).join(',')}`
          : 'space'
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
