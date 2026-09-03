import { initTRPC } from '@trpc/server'
import type { Context } from './context.ts'
import { projectRouter } from './routers/project.ts'
import { docRouter } from './routers/doc.ts'
import { runRouter } from './routers/run.ts'
import { workRouter } from './routers/work.ts'
import { insightRouter } from './routers/insight.ts'
import { settingsRouter } from './routers/settings.ts'

const t = initTRPC.context<Context>().create()

export const appRouter = t.router({
  project: projectRouter,
  doc: docRouter,
  run: runRouter,
  work: workRouter,
  insight: insightRouter,
  settings: settingsRouter,
})

export type AppRouter = typeof appRouter
