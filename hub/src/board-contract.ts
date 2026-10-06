import { z } from 'zod'

export const BoardIdSchema = z.string()
const BoardOriginSchema = z.object({
  kind: z.string(),
  session: z.string().nullable(),
  harness: z.string().nullable(),
  project: z.string().nullable(),
  runId: z.string().nullable(),
})
const BoardTagSchema = z.object({
  kind: z.enum(['task', 'path', 'topic']),
  value: z.string(),
})
const BoardMessageSchema = z.object({
  id: BoardIdSchema,
  kind: z.string().nullable(),
  threadRootId: BoardIdSchema.nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  audience: z.string().nullable(),
  origin: BoardOriginSchema.nullable(),
  senderTags: z.array(BoardTagSchema).nullable(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  state: z.string().nullable(),
  acceptedReplyId: BoardIdSchema.nullable(),
  acceptedBy: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  noteId: BoardIdSchema.nullable(),
  notePendingError: z.string().nullable(),
  revision: z.string().nullable(),
  scopeProjectIds: z.array(z.string()).nullable(),
  recipientUserIds: z.array(z.string()).nullable(),
  claimId: BoardIdSchema.nullable(),
  authorUserId: z.string().nullable(),
  authorSession: z.string().nullable(),
  ackRequired: z.boolean().nullable(),
  ackDeadline: z.string().nullable(),
  text: z.string().nullable(),
})
const BoardOverviewBaseSchema = z.object({
  id: BoardIdSchema,
  title: z.string().nullable(),
  audience: z.string().nullable(),
  origin: BoardOriginSchema,
  senderTags: z.array(BoardTagSchema),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  ackRequired: z.boolean(),
  ackDeadline: z.string().nullable(),
  state: z.enum(['open', 'accepted', 'withdrawn', 'expired']),
  reached: z.number().int().nonnegative().nullable(),
  acknowledged: z.number().int().nonnegative().nullable(),
  unacknowledged: z.array(z.string()).nullable(),
  store: z.enum(['local', 'hosted']),
})

export const BoardListResultSchema = z.object({
  messages: z.array(
    z.discriminatedUnion('kind', [
      BoardOverviewBaseSchema.extend({ kind: z.literal('notice') }),
      BoardOverviewBaseSchema.extend({
        kind: z.literal('question'),
        replyCount: z.number().int().nonnegative(),
        acceptedReplyId: BoardIdSchema.nullable(),
      }),
    ]),
  ),
  warning: z.string().nullable(),
})
export const BoardPostResultSchema = z.object({
  id: BoardIdSchema,
  dropped: z.boolean(),
  reached: z.number().int().nonnegative().nullable(),
  warning: z.string().nullable(),
})
export const BoardThreadResultSchema = z.object({
  root: BoardMessageSchema,
  replies: z.array(
    z.object({
      id: BoardIdSchema,
      body: z.string(),
      origin: BoardOriginSchema,
      createdAt: z.string(),
    }),
  ),
})
export const BoardStatusResultSchema = z.object({
  message: BoardMessageSchema,
  receipts: z.array(
    z.object({
      messageId: BoardIdSchema,
      readerUserId: z.string().nullable(),
      readerSession: z.string(),
      audienceAtPosting: z.boolean(),
      deliveredAt: z.string().nullable(),
      acknowledgedAt: z.string().nullable(),
    }),
  ),
  reached: z.number().int().nonnegative().nullable(),
  acknowledged: z.number().int().nonnegative().nullable(),
  unacknowledged: z.array(z.string()).nullable(),
})
export const BoardAcceptResultSchema = z.object({
  accepted: BoardIdSchema,
  questionId: BoardIdSchema,
  noteId: BoardIdSchema.nullable(),
  notePendingError: z.string().nullable(),
  retry: z.string().nullable(),
})

export type BoardListInput = {
  kind?: 'notice' | 'question'
  open?: boolean
  includeEnded?: boolean
}
export type BoardPostInput = {
  audience: string
  title: string
  body: string
  task?: string
  paths?: string[]
  topics?: string[]
  ackRequired?: boolean
  deadline?: string
  expires?: string
}
