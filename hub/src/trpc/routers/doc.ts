import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DOC_SCOPES } from '../../../../shared/docs.ts'
import { docGet, docHistory, docList, docRemove, docSet, docSubjects } from '../../orch.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

const scope = z.enum(DOC_SCOPES)
const subject = z.string().nullable()
const expectedRevision = z.string().trim().min(1, 'Expected revision is required').optional()
const staleRevisionMessage =
  'This document changed since you opened it. Reload to see the current version; your edit was not saved.'

async function fromOrch<T>(fn: () => Promise<T>, classifyStaleRevision = false): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause)
    const message = raw.replace(/^orch \S+ exited \d+:\s*/, '') || raw
    if (classifyStaleRevision && message.includes('refusing stale document update')) {
      throw new TRPCError({ code: 'CONFLICT', message: staleRevisionMessage, cause })
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message, cause })
  }
}

export const docRouter = t.router({
  list: t.procedure
    .input(
      z
        .object({
          scope: scope.optional(),
          subject: z.string().nullable().optional(),
        })
        .optional(),
    )
    .query(({ input }) => fromOrch(() => docList(input ?? {}))),
  get: t.procedure
    .input(z.object({ scope, subject, slug: z.string() }))
    .query(({ input }) => fromOrch(() => docGet(input.scope, input.subject, input.slug))),
  set: t.procedure
    .input(
      z.object({
        scope,
        subject,
        slug: z.string(),
        title: z.string(),
        body: z.string(),
        reason: z.string().trim().min(1, 'Reason is required'),
        delivery: z.enum(['inject', 'demand']).optional(),
        expectedRevision,
      }),
    )
    .mutation(({ input }) => fromOrch(() => docSet(input), true)),
  remove: t.procedure
    .input(
      z.object({
        scope,
        subject,
        slug: z.string(),
        reason: z.string().trim().min(1, 'Reason is required'),
        expectedRevision,
      }),
    )
    .mutation(({ input }) =>
      fromOrch(
        () =>
          docRemove(input.scope, input.subject, input.slug, input.reason, input.expectedRevision),
        true,
      ),
    ),
  history: t.procedure
    .input(z.object({ scope, subject, slug: z.string() }))
    .query(({ input }) => fromOrch(() => docHistory(input.scope, input.subject, input.slug))),
  subjects: t.procedure.query(() => fromOrch(() => docSubjects())),
})
