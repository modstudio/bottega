// concern: record-api-subjects
/** Owns validation and routing for the hosted subject JSON surface. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { SubjectDefinitionSchema } from '../../../shared/subjects.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  decodeRecordCursor,
  pageRecordItems,
  type RecordCursor,
  recordCursorOf,
} from './record-cursor.ts'
import { type RecordSubject, RecordSubjectError } from './record-subjects.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordSubjectRouteDeps = {
  listSubjects(
    input: Tenant & {
      project?: string
      includeRetired: boolean
      order: 'catalog' | 'updated'
      cursor: RecordCursor | null
      limit: number
    },
  ): Promise<RecordSubject[]>
  addSubject(
    input: Tenant & { id?: string; project: string; name: string; definition: string },
  ): Promise<RecordSubject>
  renameSubject(
    input: Tenant & { project: string; id: string; name: string },
  ): Promise<RecordSubject>
  defineSubject(
    input: Tenant & { project: string; id: string; definition: string },
  ): Promise<RecordSubject>
  reorderSubjects(input: Tenant & { project: string; ids: string[] }): Promise<RecordSubject[]>
  retireSubject(input: Tenant & { project: string; id: string }): Promise<RecordSubject>
}

const project = z.string().trim().min(1)
const id = z.string().uuid()
const name = z.string().trim().min(1)
const definition = SubjectDefinitionSchema

const invalidBody = (
  context: Context<Environment>,
  result: { error: z.ZodError },
  fallback: string,
) => {
  const definitionIssue = result.error.issues.find((issue) => issue.path[0] === 'definition')
  return context.json({ error: definitionIssue?.message ?? fallback }, 400)
}

export function registerRecordSubjectRoutes(
  app: Hono<Environment>,
  deps: RecordSubjectRouteDeps,
  ports: {
    scope(context: Context<Environment>): Tenant | null
    noSpace(context: Context<Environment>): Response
  },
): void {
  const active = (context: Context<Environment>) => {
    const tenant = ports.scope(context)
    return tenant ? { tenant } : { response: ports.noSpace(context) }
  }
  const failed = (context: Context<Environment>, error: unknown) => {
    if (error instanceof RecordSubjectError)
      return context.json({ error: error.message }, error.status)
    throw error
  }
  app.get('/v1/subjects', async (context) => {
    const bound = active(context)
    if ('response' in bound) return bound.response
    const query = z
      .object({
        project: project.optional(),
        includeRetired: z.enum(['true', 'false']).optional(),
        order: z.enum(['catalog', 'updated']).default('catalog'),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().max(500).default(100),
      })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid subject list query' }, 400)
    let cursor: RecordCursor | null = null
    try {
      cursor = query.data.cursor ? decodeRecordCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor' }, 400)
    }
    const rows = await deps.listSubjects({
      ...bound.tenant,
      project: query.data.project,
      includeRetired: query.data.includeRetired === 'true',
      order: query.data.order,
      cursor,
      limit: query.data.limit + 1,
    })
    return context.json(pageRecordItems(rows, query.data.limit, recordCursorOf, true))
  })
  app.put('/v1/subjects', async (context) => {
    const bound = active(context)
    if ('response' in bound) return bound.response
    const body = z
      .object({ id: id.optional(), project, name, definition })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return invalidBody(context, body, 'invalid subject add')
    try {
      return context.json(await deps.addSubject({ ...bound.tenant, ...body.data }))
    } catch (error) {
      return failed(context, error)
    }
  })
  app.post('/v1/subjects/:id/rename', async (context) => {
    const bound = active(context)
    if ('response' in bound) return bound.response
    const parsedId = id.safeParse(context.req.param('id'))
    const body = z.object({ project, name }).safeParse(await context.req.json().catch(() => null))
    if (!parsedId.success || !body.success)
      return context.json({ error: 'invalid subject rename' }, 400)
    try {
      return context.json(
        await deps.renameSubject({ ...bound.tenant, id: parsedId.data, ...body.data }),
      )
    } catch (error) {
      return failed(context, error)
    }
  })
  app.post('/v1/subjects/:id/define', async (context) => {
    const bound = active(context)
    if ('response' in bound) return bound.response
    const parsedId = id.safeParse(context.req.param('id'))
    const body = z
      .object({ project, definition })
      .safeParse(await context.req.json().catch(() => null))
    if (!parsedId.success) return context.json({ error: 'invalid subject definition' }, 400)
    if (!body.success) return invalidBody(context, body, 'invalid subject definition')
    try {
      return context.json(
        await deps.defineSubject({ ...bound.tenant, id: parsedId.data, ...body.data }),
      )
    } catch (error) {
      return failed(context, error)
    }
  })
  app.post('/v1/subjects/reorder', async (context) => {
    const bound = active(context)
    if ('response' in bound) return bound.response
    const body = z
      .object({ project, ids: z.array(id) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid subject reorder' }, 400)
    try {
      return context.json({ items: await deps.reorderSubjects({ ...bound.tenant, ...body.data }) })
    } catch (error) {
      return failed(context, error)
    }
  })
  app.post('/v1/subjects/:id/retire', async (context) => {
    const bound = active(context)
    if ('response' in bound) return bound.response
    const parsedId = id.safeParse(context.req.param('id'))
    const body = z.object({ project }).safeParse(await context.req.json().catch(() => null))
    if (!parsedId.success || !body.success)
      return context.json({ error: 'invalid subject retirement' }, 400)
    try {
      return context.json(
        await deps.retireSubject({ ...bound.tenant, id: parsedId.data, ...body.data }),
      )
    } catch (error) {
      return failed(context, error)
    }
  })
}
