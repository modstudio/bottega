// concern: question-store-port
/** Declares the runtime adapter that makes a run visible before its hosted question. */

import type { Database } from 'bun:sqlite'
export type QuestionRunPusher = (database: Database, runId: string) => Promise<void>

let pusher: QuestionRunPusher | null = null

export function registerQuestionRunPusher(next: QuestionRunPusher): void {
  pusher = next
}

export function resolveQuestionRunPusher(): QuestionRunPusher {
  if (!pusher)
    throw new Error(
      'hosted question run pusher is not registered in this entrypoint; boot it through the standard runtime registration (registerStandardRuntime), then retry',
    )
  return pusher
}
