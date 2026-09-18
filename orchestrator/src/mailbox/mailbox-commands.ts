// concern: run-inbox
/** Owns mailbox message parsing and reporting. Must not know CLI grammar. */
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
  id: number,
  argv: string[],
  ping: boolean,
  presentation: { log(value: string): void },
): Promise<void> {
  const sources = parseWorkerMessageArgs(argv, {
    usage: 'orch tell <run-id> ["<message>"] [--file PATH] [--ping]',
    booleans: ['--ping'],
  })
  const body = (await readMessageText({
    missing: 'no message: pass it as an argument, via --file, or on stdin',
    exclusive: 'pass the message either positionally or with --file, not both',
    sources,
  }))!
  assertWorkerText(body, 'message', TELL_WORKING_FORMS)
  const message = tellRun(id, body)
  presentation.log(
    `queued message ${message.id} for run ${message.root_run_id} (turn ${message.run_id}); it has not been read`,
  )
  const notice = deferredWorkerMessageNotice(
    message.root_run_id,
    message.transport !== null && transportFor(message.transport).canInjectMidTurn,
  )
  if (notice) presentation.log(notice)
  if (ping) presentation.log(formatPeek(peekRun(message.run_id)))
}
