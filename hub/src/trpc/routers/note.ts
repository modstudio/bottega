import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { listNotes, promoteNote } from '../../note.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

export function createNoteRouter(deps = { listNotes, promoteNote }) {
  return t.router({
    list: t.procedure
      .input(
        z.object({
          project: z.string().trim().min(1).optional(),
          stale: z.boolean().default(false),
        }),
      )
      .query(({ input }) => deps.listNotes(input)),
    promote: t.procedure
      .input(
        z.object({
          id: z.uuid(),
          title: z.string().trim().min(1, 'a promoted task needs a title stating its point'),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          return await deps.promoteNote(input.id, { title: input.title })
        } catch (cause) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          })
        }
      }),
  })
}

export const noteRouter = createNoteRouter()
