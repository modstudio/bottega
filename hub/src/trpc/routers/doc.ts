import { TRPCError, initTRPC } from '@trpc/server'
import { z } from 'zod'
import { docGet, docList, docRemove, docSet, docSubjects } from '../../orch.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

const scope = z.enum(['project', 'machine', 'agent', 'job', 'global'])
const subject = z.string().nullable()

async function fromOrch<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const message = raw.replace(/^orch \S+ exited \d+:\s*/, '') || raw
    throw new TRPCError({ code: 'BAD_REQUEST', message })
  }
}

export const docRouter = t.router({
  list: t.procedure
    .input(z.object({
      scope: scope.optional(),
      subject: z.string().nullable().optional(),
    }).optional())
    .query(({ input }) => fromOrch(() => docList(input ?? {}))),
  get: t.procedure
    .input(z.object({ scope, subject, slug: z.string() }))
    .query(({ input }) => fromOrch(() => docGet(input.scope, input.subject, input.slug))),
  set: t.procedure
    .input(z.object({
      scope, subject, slug: z.string(), title: z.string(), body: z.string(),
    }))
    .mutation(({ input }) => fromOrch(() => docSet(input))),
  remove: t.procedure
    .input(z.object({ scope, subject, slug: z.string() }))
    .mutation(({ input }) => fromOrch(() => docRemove(input.scope, input.subject, input.slug))),
  subjects: t.procedure.query(() => fromOrch(() => docSubjects())),
})
