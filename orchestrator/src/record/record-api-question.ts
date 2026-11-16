// concern: record-api-question
/** Exposes validated tenant-bound question reads and writes. */

import type { Context, Hono } from 'hono'
import {
  decodeRecordChangeCursor,
  type RecordChangeCursor,
} from '../../../shared/record/record-changes.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  type QuestionIntent,
  type QuestionWriteBody,
  questionChangedAfterRefusal,
  questionIntentSchema,
  questionReadSchema,
  questionWriteSchema,
  type RecordQuestionReadInput,
} from './record-question-contract.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordQuestionRouteDeps = {
  readQuestions?(input: Tenant & RecordQuestionReadInput): Promise<unknown>
  writeQuestion?(intent: QuestionIntent, input: Tenant & QuestionWriteBody): Promise<unknown>
}
type Ports = {
  scope(context: Context<Environment>): Tenant | null
  noSpace(context: Context<Environment>): Response
}
const DIRECT_WRITE_ISSUE_LIMIT = 3

function directWriteRefusal(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const details = issues
    .slice(0, DIRECT_WRITE_ISSUE_LIMIT)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  return `invalid direct question write request: ${details}`
}

export function registerRecordQuestionRoutes(
  app: Hono<Environment>,
  deps: RecordQuestionRouteDeps,
  ports: Ports,
): void {
  app.get('/v1/questions', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    if (!deps.readQuestions)
      return context.json({ error: 'hosted question reads are unavailable' }, 503)
    const query = questionReadSchema.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid question read query' }, 400)
    if (query.data.read === 'rulings') {
      const { changedAfter: encodedChangedAfter, ...read } = query.data
      if (encodedChangedAfter === undefined)
        return context.json(await deps.readQuestions({ ...tenant, ...read }))
      if (read.limit !== undefined)
        return context.json(
          {
            error: 'limit cannot be combined with changedAfter',
            remedy: 'drop limit; follow more to page',
          },
          422,
        )
      let changedAfter: RecordChangeCursor
      try {
        changedAfter = decodeRecordChangeCursor(encodedChangedAfter)
      } catch {
        return context.json(
          {
            error: 'record change cursor is malformed',
            remedy: 'retry without changedAfter to get a fresh cursor',
          },
          422,
        )
      }
      return context.json(await deps.readQuestions({ ...tenant, ...read, changedAfter }))
    }
    if (query.data.changedAfter !== undefined && query.data.read !== 'inbox')
      return context.json(
        {
          error: questionChangedAfterRefusal.message,
          remedy: questionChangedAfterRefusal.remedy,
        },
        422,
      )
    return context.json(await deps.readQuestions({ ...tenant, ...query.data }))
  })
  app.post('/v1/questions/:intent', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    if (!deps.writeQuestion)
      return context.json({ error: 'hosted question writes are unavailable' }, 503)
    const intent = questionIntentSchema.safeParse(context.req.param('intent'))
    const body = questionWriteSchema.safeParse(await context.req.json().catch(() => null))
    if (!intent.success || !body.success)
      return context.json(
        {
          error: body.success
            ? 'invalid direct question write request'
            : directWriteRefusal(body.error.issues),
        },
        400,
      )
    return context.json(await deps.writeQuestion(intent.data, { ...tenant, ...body.data }))
  })
}
