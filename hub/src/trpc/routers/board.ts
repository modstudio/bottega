import { initTRPC, TRPCError } from '@trpc/server'
import {
  BoardAcceptInputSchema,
  BoardIdInputSchema,
  BoardListInputSchema,
  BoardPostInputSchema,
  BoardReplyInputSchema,
} from '../../board-contract.ts'
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

export const boardRouter = t.router({
  list: t.procedure.input(BoardListInputSchema).query(({ input }) => call(() => boardList(input))),
  thread: t.procedure
    .input(BoardIdInputSchema)
    .query(({ input }) => call(() => boardThread(input.id))),
  status: t.procedure
    .input(BoardIdInputSchema)
    .query(({ input }) => call(() => boardStatus(input.id))),
  post: t.procedure.input(BoardPostInputSchema).mutation(({ input }) => {
    const { project: _project, ...localInput } = input
    return call(() => boardPost(localInput))
  }),
  reply: t.procedure
    .input(BoardReplyInputSchema)
    .mutation(({ input }) => call(() => boardReply(input))),
  accept: t.procedure
    .input(BoardAcceptInputSchema)
    .mutation(({ input }) => call(() => boardAccept(input))),
  withdraw: t.procedure
    .input(BoardIdInputSchema)
    .mutation(({ input }) => call(() => boardWithdraw(input.id))),
})
