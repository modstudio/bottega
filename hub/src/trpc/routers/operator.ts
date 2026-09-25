import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { FILING_DOC_SCOPES } from '../../../../shared/docs.ts'
import {
  operatorEmailDelayMinutes,
  setOperatorEmailDelayMinutes,
} from '../../operator-waiting-email.ts'
import {
  answerWaiting as answerWaitingThroughOrch,
  fileWaitingRuling as fileWaitingRulingThroughOrch,
  waiting as waitingThroughOrch,
} from '../../orch.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

export function createOperatorRouter(
  dependencies: {
    waiting: typeof waitingThroughOrch
    answer: typeof answerWaitingThroughOrch
    file: typeof fileWaitingRulingThroughOrch
    emailDelay?: typeof operatorEmailDelayMinutes
    setEmailDelay?: typeof setOperatorEmailDelayMinutes
  } = {
    waiting: waitingThroughOrch,
    answer: answerWaitingThroughOrch,
    file: fileWaitingRulingThroughOrch,
  },
) {
  return t.router({
    emailSettings: t.procedure.query(() => ({
      delayMinutes: (dependencies.emailDelay ?? operatorEmailDelayMinutes)(),
    })),
    setEmailSettings: t.procedure
      .input(z.object({ delayMinutes: z.number().int().min(0).max(43_200) }).strict())
      .mutation(({ input }) => {
        ;(dependencies.setEmailDelay ?? setOperatorEmailDelayMinutes)(input.delayMinutes)
        return input
      }),
    waiting: t.procedure.query(() => dependencies.waiting()),
    answer: t.procedure
      .input(
        z.object({
          runId: z.number().int().positive(),
          rulings: z
            .array(
              z.object({
                questionId: z.number().int().positive(),
                ruling: z.string().trim().min(1),
              }),
            )
            .min(1)
            .superRefine((rulings, context) => {
              const ids = new Set<number>()
              rulings.forEach(({ questionId }, index) => {
                if (ids.has(questionId))
                  context.addIssue({
                    code: 'custom',
                    path: [index, 'questionId'],
                    message: 'question ids must be unique',
                  })
                ids.add(questionId)
              })
            }),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          return await dependencies.answer(input.runId, input.rulings)
        } catch (cause) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }),
    file: t.procedure
      .input(
        z
          .object({
            questionId: z.number().int().positive(),
            as: z.enum(['doc', 'canon']),
            scope: z.enum(FILING_DOC_SCOPES).optional(),
            subject: z.string().trim().min(1).optional(),
            title: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .mutation(async ({ input }) => {
        try {
          return await dependencies.file(input)
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
