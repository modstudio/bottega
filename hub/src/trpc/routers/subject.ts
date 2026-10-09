import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { SubjectListSchema } from '../../subject-contract.ts'
import { projectSubjectList } from '../../subject-orch.ts'
import type { Context } from '../context.ts'
import { fromOrch } from '../orch-error.ts'

const t = initTRPC.context<Context>().create()

export const subjectRouter = t.router({
  list: t.procedure
    .input(z.object({ project: z.string().trim().min(1), includeRetired: z.boolean().optional() }))
    .output(SubjectListSchema)
    .query(({ input }) =>
      fromOrch(() => projectSubjectList(input.project, input.includeRetired ?? false)),
    ),
})
