// concern: record-question-store
/** Adapts hosted question routes, with only machine-owned inbox liveness enriched locally. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import type { RecordQuestionClient } from '../record/record-api-client-question.ts'
import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
} from '../record/record-question-contract.ts'
import { questionChangedAfterRefusal } from '../record/record-question-contract.ts'
import type { QuestionReadResult, QuestionReadRow, QuestionStore } from './question-store-types.ts'

function localQuestionRow(row: Record<string, unknown>): QuestionReadRow {
  const mapped = { ...row }
  if (mapped.record_id === undefined && typeof mapped.id === 'string') {
    mapped.record_id = mapped.id
    delete mapped.id
  }
  if (mapped.run_record_id === undefined && typeof mapped.run_id === 'string')
    mapped.run_record_id = mapped.run_id
  if (mapped.workflow_task_record_id === undefined && typeof mapped.workflow_task_id === 'string')
    mapped.workflow_task_record_id = mapped.workflow_task_id
  delete mapped.run_id
  delete mapped.workflow_task_id
  return mapped as QuestionReadRow
}

export class RecordQuestionStore implements QuestionStore {
  private readonly input: {
    database: Database
    client: RecordQuestionClient
    destinationSpaceId: string
    pushRun?: (runId: string) => Promise<void>
  }

  constructor(input: RecordQuestionStore['input']) {
    this.input = input
  }

  async write(intent: QuestionIntent, input: QuestionWriteBody) {
    if (!this.input.client.writeQuestion)
      throw new Error('record API predates direct question writes; release hosted-api, then retry')
    if (intent === 'ask' && input.question.runId) {
      if (!this.input.pushRun)
        throw new Error(
          `run outbox push is unavailable; run \`${PLATFORM_SLUG} record sync\`, then retry`,
        )
      await this.input.pushRun(input.question.runId)
    }
    return await this.input.client.writeQuestion(intent, input, {
      destinationSpaceId: this.input.destinationSpaceId,
    })
  }

  async read(input: QuestionReadInput): Promise<QuestionReadResult> {
    if (input.changedAfter !== undefined)
      throw new Error(
        `${questionChangedAfterRefusal.message}; ${questionChangedAfterRefusal.remedy}`,
      )
    if (!this.input.client.readQuestions)
      throw new Error('record API predates direct question reads; release hosted-api, then retry')
    const result = await this.input.client.readQuestions(input, {
      destinationSpaceId: this.input.destinationSpaceId,
    })
    const items = result.items.map(localQuestionRow)
    if (input.read !== 'inbox') return { items } as QuestionReadResult
    const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
    return {
      items: items.map((row) => {
        if (!('run_record_id' in row)) return row
        const inboxRow = row as QuestionReadRow & { session_id?: unknown }
        const sessionId = typeof inboxRow.session_id === 'string' ? inboxRow.session_id : null
        const recent = sessionId
          ? (this.input.database
              .query<{ recent: number }, [string, string]>(
                'SELECT CASE WHEN last_seen>=? THEN 1 ELSE 0 END recent FROM session_seen WHERE session_id=?',
              )
              .get(cutoff, sessionId)?.recent ?? 0)
          : 0
        return { ...row, session_recent: recent }
      }),
    } as QuestionReadResult
  }
}
