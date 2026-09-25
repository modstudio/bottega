// concern: operator-waiting
/** Thin CLI adapters for relaying and listing operator rulings. */

import type {
  ClaimedOperatorNotification,
  OperatorWaitingItem,
} from '../../../shared/orch-contract.ts'
import { bareQuestionSelector } from '../cli/args.ts'
import { claimOperatorNotifications, operatorWaiting, relayQuestion } from './operator-waiting.ts'

type Presentation = { log(value: string): void }
const hasNotification = (
  row: OperatorWaitingItem | ClaimedOperatorNotification,
): row is ClaimedOperatorNotification => 'notification' in row

export function relayCommand(
  runId: number,
  args: string[],
  note: string | undefined,
  presentation: Presentation,
): void {
  if (!note?.trim()) throw new Error('--note is required')
  const questions = args.flatMap((arg) => {
    const question = bareQuestionSelector(arg)
    return question === null ? [] : [question]
  })
  const accepted = new Set([
    `--note=${note}`,
    '--note',
    note,
    ...questions.map((question) => `--q${question}`),
  ])
  const unknown = args.filter((arg) => !accepted.has(arg))
  if (unknown.length) throw new Error(`unrecognized relay argument ${unknown[0]}`)
  if (questions.length > 1) throw new Error('pass at most one --q<id>')
  const id = relayQuestion(runId, questions[0], note.trim())
  presentation.log(`question ${id} is waiting on the operator`)
}

export function waitingCommand(
  options: { json: boolean; claimNotifications: boolean },
  presentation: Presentation,
): void {
  const rows = options.claimNotifications ? claimOperatorNotifications() : operatorWaiting()
  if (options.json) {
    presentation.log(JSON.stringify(rows))
    return
  }
  presentation.log(
    rows
      .map(
        (row) =>
          `${row.kind} ${row.id}  ${row.project}${row.task_key ? ` ${row.task_key}` : ''}  since ${row.waiting_since}\n` +
          `${row.question}\nanswer: ${row.answer_command}` +
          (hasNotification(row)
            ? `\nnotification: ${row.notification.title}\n${row.notification.body}\n${row.notification.link}`
            : ''),
      )
      .join('\n\n'),
  )
}
