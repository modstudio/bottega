// concern: record-api-question
/** Exposes validated tenant-bound question reads and writes. */

import type { Context, Hono } from 'hono'
import type { RecordIdentity } from './record-auth.ts'
import {
  type QuestionIntent,
  type QuestionReadInput,
  type QuestionWriteBody,
  questionIntentSchema,
  questionReadSchema,
  questionWriteSchema,
} from './record-question-contract.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordQuestionRouteDeps = {
  readQuestions?(input: Tenant & QuestionReadInput): Promise<unknown>
  writeQuestion?(intent: QuestionIntent, input: Tenant & QuestionWriteBody): Promise<unknown>
}
type Ports = {
  scope(context: Context<Environment>): Tenant | null
  noSpace(context: Context<Environment>): Response
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
    if (query.data.changedAfter !== undefined)
      return context.json(
        {
          error: 'hosted question changed-after reads are not served yet',
          remedy: 'retry without changedAfter; DEV-2328 decides the hosted change cursor',
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
      return context.json({ error: 'invalid direct question write request' }, 400)
    return context.json(await deps.writeQuestion(intent.data, { ...tenant, ...body.data }))
  })
}
