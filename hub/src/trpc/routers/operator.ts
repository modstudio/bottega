import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  answerWaiting as answerWaitingThroughOrch,
  waiting as waitingThroughOrch,
} from '../../orch.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

export function createOperatorRouter(
  dependencies: { waiting: typeof waitingThroughOrch; answer: typeof answerWaitingThroughOrch } = {
    waiting: waitingThroughOrch,
    answer: answerWaitingThroughOrch,
  },
) {
  return t.router({
    waiting: t.procedure.query(() => dependencies.waiting()),
    answer: t.procedure
      .input(
        z.object({
          runId: z.number().int().positive(),
          questionId: z.number().int().positive(),
          ruling: z.string().trim().min(1),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          return await dependencies.answer(input.runId, input.questionId, input.ruling)
        } catch (cause) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }),
  })
}

export const operatorRouter = createOperatorRouter()
