// concern: run-inbox
/** Owns mailbox message parsing and reporting. Must not know CLI grammar. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  assertWorkerText,
  parseWorkerMessageArgs,
  readMessageText,
  TELL_WORKING_FORMS,
} from '../cli/args.ts'
import { formatPeek, peekRun } from '../events.ts'
import { transportFor } from '../transport/transport.ts'
import { tellRun } from './mailbox.ts'
import { deferredWorkerMessageNotice } from './mailbox-notice.ts'

export async function tellCommand(
  id: string,
  argv: string[],
  ping: boolean,
  presentation: { log(value: string): void },
): Promise<void> {
  const sources = parseWorkerMessageArgs(argv, {
    usage: `${PLATFORM_SLUG} run tell <run-id> ["<message>"] [--file PATH] [--ping]`,
    booleans: ['--ping'],
    refusedOptions: {
      '--avoid': `${PLATFORM_SLUG} run start`,
      '--distinct-from': `${PLATFORM_SLUG} run start`,
      '--base': `${PLATFORM_SLUG} run start`,
      '--review': `${PLATFORM_SLUG} run start`,
      '--schema': `${PLATFORM_SLUG} run start`,
      '--transport': `${PLATFORM_SLUG} run start`,
      '--label': `${PLATFORM_SLUG} run start`,
      '--lens': `${PLATFORM_SLUG} run start`,
      '--seed': `${PLATFORM_SLUG} run start`,
      '--key': `${PLATFORM_SLUG} run start`,
      '--repo': `${PLATFORM_SLUG} run start`,
      '--cwd': `${PLATFORM_SLUG} run start`,
      '--deliverable': `${PLATFORM_SLUG} run start`,
      '--carry': `${PLATFORM_SLUG} run start`,
      '--probe': `${PLATFORM_SLUG} run start`,
      '--supplementary': `${PLATFORM_SLUG} run start`,
      '--porcelain': `${PLATFORM_SLUG} run start`,
      '--no-failover': `${PLATFORM_SLUG} run start`,
      '--keep-tree': `${PLATFORM_SLUG} run start`,
      '--keep-tree-reason': `${PLATFORM_SLUG} run start`,
      '--no-wait-capacity': `${PLATFORM_SLUG} run start`,
      '--mcp': `${PLATFORM_SLUG} run start`,
      '--receipt': `${PLATFORM_SLUG} run show`,
      '--id': `${PLATFORM_SLUG} run list`,
      '--job': `${PLATFORM_SLUG} run list`,
      '--since': `${PLATFORM_SLUG} run list`,
      '--live': `${PLATFORM_SLUG} run list`,
      '--unscored': `${PLATFORM_SLUG} run list`,
      '--quiet': `${PLATFORM_SLUG} run result`,
      '--since-base': `${PLATFORM_SLUG} run diff`,
      '--since-read': `${PLATFORM_SLUG} run diff`,
      '--days': `${PLATFORM_SLUG} run state`,
      '--limit': `${PLATFORM_SLUG} run search`,
      '--full': `${PLATFORM_SLUG} run search`,
      '--json': `${PLATFORM_SLUG} run search`,
      '--note': `${PLATFORM_SLUG} run relay`,
      '--claim-notifications': `${PLATFORM_SLUG} run waiting`,
      '--events': `${PLATFORM_SLUG} run peek`,
      '--artifacts': `${PLATFORM_SLUG} run result`,
      '--timeout': `${PLATFORM_SLUG} run wait`,
      '--agent': `${PLATFORM_SLUG} run retry`,
      '--model': `${PLATFORM_SLUG} run retry`,
      '--follow': `${PLATFORM_SLUG} run retry`,
      '--detach': `${PLATFORM_SLUG} run retry`,
      '--findings': `${PLATFORM_SLUG} run continue`,
      '--non-blocking': `${PLATFORM_SLUG} run close-out`,
      '--force': `${PLATFORM_SLUG} run abandon`,
    },
  })
  const body = (await readMessageText({
    missing: 'no message: pass it as an argument, via --file, or on stdin',
    exclusive: 'pass the message either positionally or with --file, not both',
    sources,
  }))!
  assertWorkerText(body, 'message', TELL_WORKING_FORMS)
  const message = tellRun(id, body)
  presentation.log(
    `queued message ${message.number} for run ${message.root_run_record_id} (turn ${message.run_record_id}); it has not been read`,
  )
  const notice = deferredWorkerMessageNotice(
    message.root_run_record_id,
    message.transport !== null && transportFor(message.transport).canInjectMidTurn,
  )
  if (notice) presentation.log(notice)
  if (ping) presentation.log(formatPeek(peekRun(message.run_record_id)))
}
