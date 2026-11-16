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

function localQuestionRow(
  database: Database,
  row: Record<string, unknown>,
  enrichMachineFields: boolean,
): QuestionReadRow {
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
  if (!enrichMachineFields) return mapped as QuestionReadRow
  const ownerId = typeof mapped.owner_id === 'string' ? mapped.owner_id : null
  const owner = ownerId
    ? database
        .query<{ pid: number | null; cwd: string | null }, [string]>(
          'SELECT pid,cwd FROM run WHERE record_id=?',
        )
        .get(ownerId)
    : null
  mapped.owner_pid = owner?.pid ?? null
  const repo = typeof mapped.repo === 'string' ? mapped.repo : null
  mapped.project_path = repo
    ? (database.query<{ path: string }, [string]>('SELECT path FROM project WHERE name=?').get(repo)
        ?.path ?? null)
    : null
  mapped.cwd = owner?.cwd ?? mapped.project_path
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
    if (input.changedAfter !== undefined && input.read !== 'rulings' && input.read !== 'inbox')
      throw new Error(
        `${questionChangedAfterRefusal.message}; ${questionChangedAfterRefusal.remedy}`,
      )
    if (!this.input.client.readQuestions)
      throw new Error('record API predates direct question reads; release hosted-api, then retry')
    const result = await this.input.client.readQuestions(input, {
      destinationSpaceId: this.input.destinationSpaceId,
    })
    const enrichMachineFields = ['by-id', 'for-run', 'for-cursor', 'by-number'].includes(input.read)
    const items = result.items.map((row) =>
      localQuestionRow(this.input.database, row, enrichMachineFields),
    )
    if (input.read !== 'inbox')
      return {
        items,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
        ...(result.more === undefined ? {} : { more: result.more }),
        ...(result.reset === undefined ? {} : { reset: result.reset }),
      }
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
