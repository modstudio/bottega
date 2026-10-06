import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  boardAccept,
  boardList,
  boardPost,
  boardReply,
  boardStatus,
  boardThread,
  boardWithdraw,
} from '../../orch.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()
const boardId = z
  .string()
  .refine(
    (id) =>
      (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    'board id must be a positive integer string or UUID',
  )

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    })
  }
}

const postInput = z.object({
  audience: z.string(),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  task: z.string().optional(),
  paths: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  ackRequired: z.boolean().optional(),
  deadline: z.string().optional(),
  expires: z.string().optional(),
})

export const boardRouter = t.router({
  list: t.procedure
    .input(
      z.object({
        kind: z.enum(['notice', 'question']).optional(),
        open: z.boolean().optional(),
        includeEnded: z.boolean().optional(),
      }),
    )
    .query(({ input }) => call(() => boardList(input))),
  thread: t.procedure
    .input(z.object({ id: boardId }))
    .query(({ input }) => call(() => boardThread(input.id))),
  status: t.procedure
    .input(z.object({ id: boardId }))
    .query(({ input }) => call(() => boardStatus(input.id))),
  post: t.procedure.input(postInput).mutation(({ input }) => call(() => boardPost(input))),
  reply: t.procedure
    .input(z.object({ id: boardId, body: z.string().trim().min(1) }))
    .mutation(({ input }) => call(() => boardReply(input))),
  accept: t.procedure
    .input(z.object({ questionId: boardId, replyId: boardId }))
    .mutation(({ input }) => call(() => boardAccept(input))),
  withdraw: t.procedure
    .input(z.object({ id: boardId }))
    .mutation(({ input }) => call(() => boardWithdraw(input.id))),
})
