import { z } from 'zod'
import { BOARD_PURPOSES } from '../../shared/board-purpose.ts'
import {
  BoardListResultSchema,
  BoardStatusResultSchema,
  BoardThreadResultSchema,
} from './board-contract.ts'

type BoardClientOptions = {
  baseUrl: string
  headers: { cookie?: string; authorization?: string }
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  requestDeadlineMs?: number
}
type Request = <T>(
  options: BoardClientOptions,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
) => Promise<T>

const boardRootSchema = BoardThreadResultSchema.shape.root
const messageSchema = boardRootSchema.omit({ text: true }).extend({
  spaceId: z.string(),
  kind: z.string(),
  body: z.string(),
  origin: boardRootSchema.shape.origin.unwrap(),
  senderTags: boardRootSchema.shape.senderTags.unwrap(),
  createdAt: z.string(),
  revision: z.string(),
  scopeProjectIds: z.array(z.string()),
  recipientUserIds: z.array(z.string()),
  authorUserId: z.string(),
  ackRequired: z.boolean(),
})
const threadSchema = z.object({
  root: messageSchema,
  replies: BoardThreadResultSchema.shape.replies,
})
const statusSchema = z.object({
  message: messageSchema,
  receipts: z.array(
    BoardStatusResultSchema.shape.receipts.element.extend({ readerUserId: z.string() }),
  ),
})
const listSchema = z.object({
  messages: BoardListResultSchema.shape.messages.refine(
    (messages) => messages.every((message) => message.store === 'hosted'),
    'hosted board messages must use the hosted store',
  ),
  truncated: z.boolean(),
})
const postSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('notice'),
  purpose: z.enum(BOARD_PURPOSES).optional(),
  audience: z.string(),
  title: z.string(),
  body: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  ackRequired: z.boolean().optional(),
  ackDeadline: z.string().datetime({ offset: true }).nullable().optional(),
  task: z.string().optional(),
  paths: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  project: z.string().optional(),
})
const replySchema = z.object({ id: z.string().uuid(), body: z.string() })
const destinationHeaders = (spaceId: string) => ({
  'content-type': 'application/json',
  'x-record-space': spaceId,
})

export function recordBoardClient(options: BoardClientOptions, request: Request) {
  return {
    boardList: (input: {
      kind?: 'notice' | 'question'
      open?: boolean
      includeEnded?: boolean
    }) => {
      const query = new URLSearchParams()
      if (input.kind) query.set('kind', input.kind)
      if (input.open) query.set('open', 'true')
      if (input.includeEnded) query.set('includeEnded', 'true')
      const suffix = query.toString()
      return request(options, `/v1/board/messages${suffix ? `?${suffix}` : ''}`, listSchema)
    },
    boardThread: (id: string) =>
      request(options, `/v1/board/threads/${encodeURIComponent(id)}`, threadSchema),
    boardStatus: (id: string) =>
      request(options, `/v1/board/messages/${encodeURIComponent(id)}/status`, statusSchema),
    boardPost: (input: z.input<typeof postSchema>, spaceId: string) =>
      request(options, '/v1/board/messages', messageSchema, {
        method: 'PUT',
        headers: destinationHeaders(spaceId),
        body: JSON.stringify(postSchema.parse(input)),
      }),
    boardReply: (rootId: string, input: z.input<typeof replySchema>, spaceId: string) =>
      request(options, `/v1/board/messages/${encodeURIComponent(rootId)}/replies`, messageSchema, {
        method: 'POST',
        headers: destinationHeaders(spaceId),
        body: JSON.stringify(replySchema.parse(input)),
      }),
    boardAccept: (questionId: string, replyId: string, spaceId: string) =>
      request(
        options,
        `/v1/board/messages/${encodeURIComponent(questionId)}/accept`,
        threadSchema,
        {
          method: 'POST',
          headers: destinationHeaders(spaceId),
          body: JSON.stringify({ replyId }),
        },
      ),
    boardWithdraw: (id: string, spaceId: string) =>
      request(options, `/v1/board/messages/${encodeURIComponent(id)}/withdraw`, messageSchema, {
        method: 'POST',
        headers: destinationHeaders(spaceId),
        body: JSON.stringify({}),
      }),
  }
}
