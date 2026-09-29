import { initTRPC } from '@trpc/server'
import type { Context } from './context.ts'
import { catalogRouter } from './routers/catalog.ts'
import { contextRouter } from './routers/context.ts'
import { docRouter } from './routers/doc.ts'
import { insightRouter } from './routers/insight.ts'
import { noteRouter } from './routers/note.ts'
import { operatorRouter } from './routers/operator.ts'
import { projectRouter } from './routers/project.ts'
import { recordRouter } from './routers/record.ts'
import { runRouter } from './routers/run.ts'
import { workRouter } from './routers/work.ts'

const t = initTRPC.context<Context>().create()

export const appRouter = t.router({
  project: projectRouter,
  doc: docRouter,
  run: runRouter,
  work: workRouter,
  insight: insightRouter,
  catalog: catalogRouter,
  context: contextRouter,
  note: noteRouter,
  operator: operatorRouter,
  record: recordRouter,
})

export type AppRouter = typeof appRouter
export type { HostedRouter } from './hosted-router.ts'
