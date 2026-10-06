import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { DOC_AUDIENCES, DOC_SCOPES } from '../../../../shared/docs.ts'
import { docGet, docHistory, docList, docRemove, docSet, docSubjects } from '../../orch.ts'
import type { Context } from '../context.ts'
import { fromOrch } from '../orch-error.ts'

const t = initTRPC.context<Context>().create()

const scope = z.enum(DOC_SCOPES)
const subject = z.string().nullable()
const expectedRevision = z.string().trim().min(1, 'Expected revision is required').optional()
export const docRouter = t.router({
  list: t.procedure
    .input(
      z
        .object({
          scope: scope.optional(),
          subject: z.string().nullable().optional(),
          audience: z.enum(DOC_AUDIENCES).optional(),
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
        audience: z.enum(DOC_AUDIENCES).optional(),
        parentSlug: z.string().nullable().optional(),
        position: z.number().int().optional(),
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
