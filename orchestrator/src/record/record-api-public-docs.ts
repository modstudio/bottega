// concern: record-api-public-docs
/** Validates and serves public document reads and document search. Must not know SQL. */
import type { Context, Env, Hono } from 'hono'
import { getConnInfo } from 'hono/bun'
import { MemoryStore, rateLimiter } from 'hono-rate-limiter'
import { z } from 'zod'
import { DOC_AUDIENCES } from '../../../shared/docs.ts'
import type {
  PublicRecordDoc,
  PublicRecordDocTreeItem,
  RecordDocSearchInput,
  RecordDocSearchMatch,
} from './record-public-docs.ts'

const PUBLIC_DOC_RATE_LIMIT = 60
const PUBLIC_DOC_RATE_WINDOW_MS = 60_000
const PUBLIC_DOC_CACHE_CONTROL = 'public, max-age=60'

type Tenant = {
  url: string
  userId: string
  spaceId: string
  spaceIds: string[]
}

export type PublicDocRouteDeps = {
  recordUrl: string
  listPublicDocs(input: { url: string }): Promise<PublicRecordDocTreeItem[]>
  readPublicDoc(input: { url: string; id: string }): Promise<PublicRecordDoc | null>
  searchPublicDocs(input: { url: string; query: string }): Promise<RecordDocSearchMatch[]>
}

export type SignedDocSearchRouteDeps = {
  searchDocs(input: Tenant & RecordDocSearchInput): Promise<RecordDocSearchMatch[]>
}

const idSchema = z.string().uuid()
const searchQuerySchema = z.object({ q: z.string().default('') })

function connectionAddress(context: Context): string {
  try {
    return getConnInfo(context).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const publicDocLimiter = rateLimiter({
  windowMs: PUBLIC_DOC_RATE_WINDOW_MS,
  limit: PUBLIC_DOC_RATE_LIMIT,
  store: new MemoryStore(),
  keyGenerator: (context) => context.req.header('Fly-Client-IP') ?? connectionAddress(context),
})

export function registerPublicDocRoutes<E extends Env>(
  app: Hono<E>,
  deps: PublicDocRouteDeps,
): void {
  app.use('/public/v1/*', publicDocLimiter)
  app.get('/public/v1/docs', async (context) => {
    const items = await deps.listPublicDocs({ url: deps.recordUrl })
    context.header('Cache-Control', PUBLIC_DOC_CACHE_CONTROL)
    return context.json({ items })
  })
  app.get('/public/v1/docs/search', async (context) => {
    const query = searchQuerySchema.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid doc search query' }, 400)
    const items = await deps.searchPublicDocs({ url: deps.recordUrl, query: query.data.q })
    context.header('Cache-Control', 'no-store')
    return context.json({ items })
  })
  app.get('/public/v1/docs/:id', async (context) => {
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) {
      context.header('Cache-Control', 'no-store')
      return context.json({ error: 'doc id must be a uuid' }, 400)
    }
    const doc = await deps.readPublicDoc({ url: deps.recordUrl, id: id.data })
    context.header('Cache-Control', doc ? PUBLIC_DOC_CACHE_CONTROL : 'no-store')
    return doc ? context.json(doc) : context.json({ error: 'doc not found' }, 404)
  })
}

export function registerSignedDocSearchRoute<E extends Env>(
  app: Hono<E>,
  deps: SignedDocSearchRouteDeps,
  routes: {
    scope(context: Context<E>): Tenant | null
    noSpace(context: Context<E>): Response
  },
): void {
  app.get('/v1/docs/search', async (context) => {
    const tenant = routes.scope(context)
    if (!tenant) return routes.noSpace(context)
    const query = z
      .object({
        q: z.string().default(''),
        scope: z.string().min(1).optional(),
        subject: z.string().optional(),
        audience: z.enum(DOC_AUDIENCES).optional(),
        acrossReadableSpaces: z
          .enum(['true', 'false'])
          .optional()
          .transform((value) => value === 'true'),
      })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid doc search query' }, 400)
    const input: RecordDocSearchInput = {
      query: query.data.q,
      scope: query.data.scope,
      subject: query.data.subject === undefined ? undefined : query.data.subject || null,
      audience: query.data.audience,
      acrossReadableSpaces: Boolean(query.data.acrossReadableSpaces),
    }
    return context.json({ items: await deps.searchDocs({ ...tenant, ...input }) })
  })
}
