// concern: record-question-store
/** Adapts hosted question routes, with only machine-owned inbox liveness enriched locally. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { RecordApiRequestError } from '../record/record-api-client-response.ts'
import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
} from '../record/record-question-contract.ts'
import type {
  QuestionReadResult,
  QuestionRouteClient,
  QuestionStore,
} from './question-store-types.ts'

const changedAfterRefusal =
  'hosted question changed-after reads are not served yet; retry without changedAfter; DEV-2328 decides the hosted change cursor'

export class RecordQuestionStore implements QuestionStore {
  constructor(
    private readonly input: {
      database: Database
      client: QuestionRouteClient
      destinationSpaceId: string
      pushRun?: (runId: string) => Promise<void>
    },
  ) {}

  async write(intent: QuestionIntent, input: QuestionWriteBody) {
    if (!this.input.client.writeQuestion)
      throw new Error('record API predates direct question writes; release hosted-api, then retry')
    try {
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
    } catch (error) {
      if (error instanceof RecordApiRequestError && error.kind === 'unreachable') throw error
      throw error
    }
  }

  async read(input: QuestionReadInput): Promise<QuestionReadResult> {
    if (input.changedAfter !== undefined) throw new Error(changedAfterRefusal)
    if (!this.input.client.readQuestions)
      throw new Error('record API predates direct question reads; release hosted-api, then retry')
    const result = await this.input.client.readQuestions(input, {
      destinationSpaceId: this.input.destinationSpaceId,
    })
    if (input.read !== 'inbox') return result
    const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
    return {
      items: result.items.map((row) => {
        const sessionId = typeof row.run_session_id === 'string' ? row.run_session_id : null
        const recent = sessionId
          ? (this.input.database
              .query<{ recent: number }, [string, string]>(
                'SELECT CASE WHEN last_seen>=? THEN 1 ELSE 0 END recent FROM session_seen WHERE session_id=?',
              )
              .get(cutoff, sessionId)?.recent ?? 0)
          : 0
        return { ...row, session_recent: recent }
      }),
    }
  }
}
