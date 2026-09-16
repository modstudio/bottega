import { initTRPC } from '@trpc/server'
import type { Context } from './context.ts'
import { catalogRouter } from './routers/catalog.ts'
import { docRouter } from './routers/doc.ts'
import { insightRouter } from './routers/insight.ts'
import { noteRouter } from './routers/note.ts'
import { projectRouter } from './routers/project.ts'
import { recordRouter } from './routers/record.ts'
import { runRouter } from './routers/run.ts'
import { settingsRouter } from './routers/settings.ts'
import { workRouter } from './routers/work.ts'

const t = initTRPC.context<Context>().create()

export const appRouter = t.router({
  project: projectRouter,
  doc: docRouter,
  run: runRouter,
  work: workRouter,
  insight: insightRouter,
  settings: settingsRouter,
  catalog: catalogRouter,
  note: noteRouter,
  record: recordRouter,
})

export type AppRouter = typeof appRouter
