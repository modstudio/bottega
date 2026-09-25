// concern: operator-waiting
/** Thin CLI adapters for relaying and listing operator rulings. */

import { operatorWaiting, relayQuestion } from './operator-waiting.ts'

type Presentation = { log(value: string): void }

export function relayCommand(
  runId: number,
  questionId: number | undefined,
  note: string | undefined,
  presentation: Presentation,
): void {
  if (!note?.trim()) throw new Error('--note is required')
  const id = relayQuestion(runId, questionId, note)
  presentation.log(`question ${id} is waiting on the operator`)
}

export function waitingCommand(json: boolean, presentation: Presentation): void {
  const rows = operatorWaiting()
  if (json) {
    presentation.log(JSON.stringify(rows))
    return
  }
  presentation.log(
    rows
      .map(
        (row) =>
          `${row.kind} ${row.id}  ${row.project}${row.task_key ? ` ${row.task_key}` : ''}  since ${row.waiting_since}\n` +
          `${row.question}\nanswer: ${row.answer_command}`,
      )
      .join('\n\n'),
  )
}
