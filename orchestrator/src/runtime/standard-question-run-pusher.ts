// concern: runtime-registration
/** Connects hosted question writes to the standard record synchronization adapter. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  registerQuestionRunPusher,
  type QuestionRunPusher,
} from '../question-store/question-run-pusher.ts'
import { syncRecord } from '../record/record-sync.ts'

const pushQuestionRun: QuestionRunPusher = async (database, runId) => {
  await syncRecord({ local: database })
  const synced = database
    .query<{ synced_at: string | null }, [string]>(
      `SELECT synced_at FROM outbox WHERE kind='run' AND row_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(runId)
  if (!synced?.synced_at)
    throw new Error(
      `run ${runId} did not reach the hosted record; run \`${PLATFORM_SLUG} record sync\`, inspect the outbox refusal, then retry`,
    )
}

export function registerStandardQuestionRunPusher(): void {
  registerQuestionRunPusher(pushQuestionRun)
}
