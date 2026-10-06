import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  BOARD_DEFAULT_EXPIRY_MS,
  parseBoardDuration,
} from '../../../../shared/board-duration.ts'
import { newRecordId } from '../../../../shared/record/schema.ts'
import {
  BoardAcceptInputSchema,
  BoardAcceptResultSchema,
  BoardIdInputSchema,
  BoardListInputSchema,
  BoardListResultSchema,
  BoardPostInputSchema,
  BoardPostResultSchema,
  BoardReplyInputSchema,
  BoardReplyResultSchema,
  BoardStatusResultSchema,
  BoardThreadResultSchema,
  BoardWithdrawResultSchema,
} from '../../board-contract.ts'
import type { RecordClient } from '../../record-client.ts'
import type { Context } from '../context.ts'
import { recordClient } from './record.ts'

const t = initTRPC.context<Context>().create()

type HostedBoardClient = Pick<
  RecordClient,
  | 'boardList'
  | 'boardThread'
  | 'boardStatus'
  | 'boardPost'
  | 'boardReply'
  | 'boardAccept'
  | 'boardWithdraw'
>
type HostedBoardDeps = {
  clientFor: (context: Context) => HostedBoardClient
  clock: () => number
  newId: () => string
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    if (cause instanceof TRPCError) throw cause
    if (cause instanceof z.ZodError)
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'the hosted record returned a board response this hub does not understand; the hub and record API versions differ',
        cause,
      })
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    })
  }
}

export function createHostedBoardRouter(
  deps: HostedBoardDeps = { clientFor: recordClient, clock: Date.now, newId: newRecordId },
) {
  return t.router({
    list: t.procedure.input(BoardListInputSchema).query(({ ctx, input }) =>
      call(async () => {
        const result = await deps.clientFor(ctx).boardList(input)
        return BoardListResultSchema.parse({
          messages: result.messages,
          warning: result.truncated ? 'Only the newest messages are listed.' : null,
        })
      }),
    ),
    thread: t.procedure.input(BoardIdInputSchema).query(({ ctx, input }) =>
      call(async () => {
        const thread = await deps.clientFor(ctx).boardThread(input.id)
        return BoardThreadResultSchema.parse({
          ...thread,
          root: { ...thread.root, text: null },
        })
      }),
    ),
    status: t.procedure.input(BoardIdInputSchema).query(({ ctx, input }) =>
      call(async () => {
        const status = await deps.clientFor(ctx).boardStatus(input.id)
        return BoardStatusResultSchema.parse({
          message: { ...status.message, text: null },
          receipts: status.receipts,
          reached: null,
          acknowledged: null,
          unacknowledged: null,
        })
      }),
    ),
    post: t.procedure.input(BoardPostInputSchema).mutation(({ ctx, input }) =>
      call(async () => {
        const id = deps.newId()
        const now = deps.clock()
        const message = await deps.clientFor(ctx).boardPost({
          id,
          kind: 'notice',
          audience: input.audience,
          title: input.title,
          body: input.body,
          expiresAt: new Date(
            now + (input.expires ? parseBoardDuration(input.expires) : BOARD_DEFAULT_EXPIRY_MS),
          ).toISOString(),
          ...(input.ackRequired
            ? {
                ackRequired: true,
                ackDeadline: new Date(
                  now +
                    (input.deadline
                      ? parseBoardDuration(input.deadline)
                      : BOARD_DEFAULT_ACK_DEADLINE_MS),
                ).toISOString(),
              }
            : {}),
          ...(input.task ? { task: input.task } : {}),
          ...(input.paths ? { paths: input.paths } : {}),
          ...(input.topics ? { topics: input.topics } : {}),
          ...(input.project ? { project: input.project } : {}),
        })
        return BoardPostResultSchema.parse({
          id: message.id,
          dropped: message.id !== id,
          reached: null,
          warning: null,
        })
      }),
    ),
    reply: t.procedure.input(BoardReplyInputSchema).mutation(({ ctx, input }) =>
      call(async () => {
        const message = await deps.clientFor(ctx).boardReply(input.id, {
          id: deps.newId(),
          body: input.body,
        })
        return BoardReplyResultSchema.parse({
          id: message.id,
          rootId: message.threadRootId,
          dropped: false,
          reached: null,
          warning: null,
        })
      }),
    ),
    accept: t.procedure.input(BoardAcceptInputSchema).mutation(({ ctx, input }) =>
      call(async () => {
        const thread = await deps.clientFor(ctx).boardAccept(input.questionId, input.replyId)
        return BoardAcceptResultSchema.parse({
          accepted: input.replyId,
          questionId: input.questionId,
          noteId: thread.root.noteId,
          notePendingError: thread.root.notePendingError,
          retry: null,
        })
      }),
    ),
    withdraw: t.procedure.input(BoardIdInputSchema).mutation(({ ctx, input }) =>
      call(async () => {
        const message = await deps.clientFor(ctx).boardWithdraw(input.id)
        return BoardWithdrawResultSchema.parse({ withdrawn: message.id })
      }),
    ),
  })
}

export const hostedBoardRouter = createHostedBoardRouter()
