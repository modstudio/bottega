import { z } from 'zod'
import { hasRecordIdShape } from '../../shared/record-id.ts'

export const BoardIdSchema = z
  .string()
  .refine(
    (id) => (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) || hasRecordIdShape(id),
    'board id must be a positive integer string or UUID',
  )
export const BoardIdInputSchema = z.object({ id: BoardIdSchema })
export const BoardListInputSchema = z.object({
  kind: z.enum(['notice', 'question']).optional(),
  open: z.boolean().optional(),
  includeEnded: z.boolean().optional(),
})
export const BoardPostInputSchema = z.object({
  audience: z.string(),
  project: z.string().optional(),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  task: z.string().optional(),
  paths: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  ackRequired: z.boolean().optional(),
  deadline: z.string().optional(),
  expires: z.string().optional(),
})
export const BoardReplyInputSchema = z.object({
  id: BoardIdSchema,
  body: z.string().trim().min(1),
})
export const BoardAcceptInputSchema = z.object({
  questionId: BoardIdSchema,
  replyId: BoardIdSchema,
})
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
export const BoardReplyResultSchema = BoardPostResultSchema.extend({ rootId: BoardIdSchema })
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
export const BoardWithdrawResultSchema = z.object({ withdrawn: BoardIdSchema })

export type BoardListInput = z.infer<typeof BoardListInputSchema>
export type BoardPostInput = z.infer<typeof BoardPostInputSchema>
