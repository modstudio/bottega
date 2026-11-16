// concern: question-store-port
/** Declares the runtime adapter that makes a run visible before its hosted question. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type QuestionRunPusher = (database: Database, runId: string) => Promise<void>

let pusher: QuestionRunPusher | null = null

export function registerQuestionRunPusher(next: QuestionRunPusher): void {
  pusher = next
}

export function resolveQuestionRunPusher(): QuestionRunPusher {
  if (!pusher)
    throw new Error(
      `hosted question run pusher is not registered; run \`${PLATFORM_SLUG} record sync\`, then retry`,
    )
  return pusher
}
