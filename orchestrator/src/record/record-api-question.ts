// concern: record-api-question
/** Exposes validated tenant-bound question reads and writes. */

import type { Context, Hono } from 'hono'
import { maskHostedWrite } from '../../../shared/hosted-secret-mask.ts'
import {
  decodeRecordChangeCursor,
  type RecordChangeCursor,
} from '../../../shared/record/record-changes.ts'
import type { RecordIdentity } from './record-auth.ts'
import { parseRulingPageCursor } from './record-cursor.ts'
import { recordKeyedNotVisibleRefusal } from './record-keyed-read.ts'
import {
  type QuestionIntent,
  type QuestionIntentBody,
  type QuestionReadInput,
  questionChangedAfterRefusal,
  questionImportSchema,
  questionIntentSchema,
  questionReadSchema,
  questionWriteSchema,
  type RecordQuestionReadInput,
  type RulingPageCursor,
  UnboundedQuestionRulingsError,
} from './record-question-contract.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = {
  url: string
  userId: string
  spaceId: string
  spaceIds: string[]
  uuidKeyedRead?: true
}
export type RecordQuestionRouteDeps = {
  readQuestions?(input: Tenant & RecordQuestionReadInput): Promise<unknown>
  writeQuestion?(intent: QuestionIntent, input: Tenant & QuestionIntentBody): Promise<unknown>
}

async function rulingReadResponse(
  context: Context<Environment>,
  readQuestions: NonNullable<RecordQuestionRouteDeps['readQuestions']>,
  tenant: Tenant,
  input: Extract<QuestionReadInput, { read: 'rulings' }>,
): Promise<Response> {
  const serve = async (read: Tenant & RecordQuestionReadInput): Promise<Response> => {
    try {
      return context.json(await readQuestions(read))
    } catch (error) {
      if (error instanceof UnboundedQuestionRulingsError)
        return context.json({ error: error.message, remedy: error.remedy }, 422)
      throw error
    }
  }
  const { changedAfter: encodedChangedAfter, ...read } = input
  if (encodedChangedAfter === undefined) return serve({ ...tenant, ...read })
  if (read.limit !== undefined)
    return context.json(
      {
        error: 'limit cannot be combined with changedAfter',
        remedy: 'drop limit; follow more to page',
      },
      422,
    )
  let changedAfter: RecordChangeCursor | RulingPageCursor
  try {
    changedAfter = encodedChangedAfter.startsWith('page:')
      ? parseRulingPageCursor(encodedChangedAfter)
      : decodeRecordChangeCursor(encodedChangedAfter)
  } catch {
    return context.json(
      {
        error: 'record change cursor is malformed',
        remedy: 'retry without changedAfter to get a fresh cursor',
      },
      422,
    )
  }
  return serve({ ...tenant, ...read, changedAfter })
}
type Ports = {
  scope(context: Context<Environment>): Tenant | null
  noSpace(context: Context<Environment>): Response
}
function isEmptyQuestionRead(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('items' in result)) return false
  return Array.isArray(result.items) && result.items.length === 0
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
    if (query.data.read === 'rulings')
      return rulingReadResponse(context, deps.readQuestions, tenant, query.data)
    if (query.data.changedAfter !== undefined && query.data.read !== 'inbox')
      return context.json(
        {
          error: questionChangedAfterRefusal.message,
          remedy: questionChangedAfterRefusal.remedy,
        },
        422,
      )
    const result = await deps.readQuestions({ ...tenant, ...query.data })
    if (tenant.uuidKeyedRead && query.data.read === 'by-id' && isEmptyQuestionRead(result))
      return context.json(recordKeyedNotVisibleRefusal(tenant.spaceIds.length), 404)
    return context.json(result)
  })
  app.post('/v1/questions/:intent', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    if (!deps.writeQuestion)
      return context.json({ error: 'hosted question writes are unavailable' }, 503)
    const intent = questionIntentSchema.safeParse(context.req.param('intent'))
    const rawBody = await context.req.json().catch(() => null)
    const body =
      intent.success && intent.data === 'import'
        ? questionImportSchema.safeParse(rawBody)
        : questionWriteSchema.safeParse(rawBody)
    if (!intent.success || !body.success)
      return context.json(
        {
          error: directWriteRefusal([
            ...(intent.success
              ? []
              : intent.error.issues.map((issue) => ({ ...issue, path: ['(intent)'] }))),
            ...(body.success ? [] : body.error.issues),
          ]),
        },
        400,
      )
    return context.json(
      await deps.writeQuestion(
        intent.data,
        maskHostedWrite('record.question.write', { ...tenant, ...body.data }),
      ),
    )
  })
}
