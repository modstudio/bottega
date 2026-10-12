// concern: record-api-releases
/** Hosted release HTTP routes. Must not know SQL or local release execution. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import { decodeRecordCursor, encodeRecordCursor, type RecordCursor } from './record-cursor.ts'
import {
  type LatestRecordRelease,
  type RecordRelease,
  RecordReleaseSpaceRequiredError,
} from './record-release-reading.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }

export type RecordReleaseRouteDeps = {
  readReleases(
    input: Tenant & {
      project: string
      limit: number
      before: RecordCursor | null
    },
  ): Promise<RecordRelease[] | null>
  readLatestReleases(input: Tenant & { project: string }): Promise<LatestRecordRelease[] | null>
}

const project = z.string().trim().min(1)
const limit = z.coerce.number().int().min(1).max(100).default(20)
const spaceRequired = (context: Context<Environment>) =>
  context.json(
    {
      error: 'project exists in more than one record space; select a space',
      remedy: 'send x-record-space to select the record space',
    },
    409,
  )

export function registerRecordReleaseRoutes(
  app: Hono<Environment>,
  deps: RecordReleaseRouteDeps,
  ports: {
    scope(context: Context<Environment>): Tenant | null
    noSpace(context: Context<Environment>): Response
  },
): void {
  app.get('/v1/releases', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const query = z
      .object({ project, limit, before: z.string().optional() })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid release list query' }, 400)
    let before: RecordCursor | null = null
    try {
      before = query.data.before ? decodeRecordCursor(query.data.before) : null
    } catch {
      return context.json({ error: 'invalid before cursor' }, 400)
    }
    let items: RecordRelease[] | null
    try {
      items = await deps.readReleases({
        ...tenant,
        project: query.data.project,
        limit: query.data.limit,
        before,
      })
    } catch (error) {
      if (error instanceof RecordReleaseSpaceRequiredError) return spaceRequired(context)
      throw error
    }
    if (!items) return context.json({ error: 'project not found' }, 404)
    const hasMore = items.length > query.data.limit
    if (hasMore) items.pop()
    const last = items.at(-1)
    return context.json({
      items,
      nextCursor: hasMore && last ? encodeRecordCursor({ at: last.startedAt, id: last.id }) : null,
    })
  })

  app.get('/v1/releases/latest', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const query = z.object({ project }).safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid latest release query' }, 400)
    let items: LatestRecordRelease[] | null
    try {
      items = await deps.readLatestReleases({ ...tenant, project: query.data.project })
    } catch (error) {
      if (error instanceof RecordReleaseSpaceRequiredError) return spaceRequired(context)
      throw error
    }
    return items ? context.json({ items }) : context.json({ error: 'project not found' }, 404)
  })
}
