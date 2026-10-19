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
  runId: string,
  args: string[],
  note: string | undefined,
  presentation: Presentation,
  resolveQuestion: (identifier: string) => number,
): void {
  if (!note?.trim()) throw new Error('--note is required')
  const accepted = new Set([`--note=${note}`, '--note', note])
  const selectors = args.filter((arg) => !accepted.has(arg))
  const questions = selectors.map((arg) => {
    const question = bareQuestionSelector(arg)
    if (question === null) throw new Error(`unrecognized relay argument ${arg}`)
    return question
  })
  if (questions.length > 1) throw new Error('pass at most one --q<id>')
  const question = questions[0] === undefined ? undefined : resolveQuestion(questions[0])
  const { id } = relayQuestion(runId, question, note.trim())
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
