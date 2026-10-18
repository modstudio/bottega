// concern: record-api-workflow
/** Exposes validated tenant-bound workflow catalogue routes. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import { decodeRecordCursor, pageRecordItems, type RecordCursor } from './record-cursor.ts'
import {
  type RecordWorkflowDraftInput,
  RecordWorkflowError,
  type RecordWorkflowImportInput,
  type RecordWorkflowTable,
  type RecordWorkflowTransitionInput,
  recordWorkflowDraftSchema,
  recordWorkflowImportSchema,
  recordWorkflowTableSchema,
  recordWorkflowTransitionSchema,
} from './record-workflow-contract.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordWorkflowRouteDeps = {
  listWorkflowCatalogue(
    input: Tenant & { table: RecordWorkflowTable; limit: number; cursor: RecordCursor | null },
  ): Promise<Record<string, unknown>[]>
  draftWorkflow(input: Tenant & RecordWorkflowDraftInput): Promise<unknown>
  promoteWorkflow(input: Tenant & RecordWorkflowTransitionInput): Promise<unknown>
  retireWorkflow(input: Tenant & RecordWorkflowTransitionInput): Promise<unknown>
  importWorkflowCatalogue?(input: Tenant & RecordWorkflowImportInput): Promise<unknown>
}
type Ports = {
  scope(context: Context<Environment>): Tenant | null
  noSpace(context: Context<Environment>): Response
}
const limit = z.coerce.number().int().min(1).max(100).default(20)

export function registerRecordWorkflowRoutes(
  app: Hono<Environment>,
  deps: RecordWorkflowRouteDeps,
  ports: Ports,
): void {
  const failure = (context: Context<Environment>, error: unknown) =>
    error instanceof RecordWorkflowError
      ? context.json({ error: error.message }, error.status as 404 | 409 | 422)
      : (() => {
          throw error
        })()
  app.get('/v1/workflow-catalogue/:table', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const table = recordWorkflowTableSchema.safeParse(context.req.param('table'))
    const query = z.object({ limit, cursor: z.string().optional() }).safeParse(context.req.query())
    if (!table.success || !query.success)
      return context.json({ error: 'invalid workflow catalogue list request' }, 400)
    let cursor = null
    try {
      cursor = query.data.cursor ? decodeRecordCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor' }, 400)
    }
    const items = await deps.listWorkflowCatalogue({
      ...active,
      table: table.data,
      limit: query.data.limit,
      cursor,
    })
    return context.json(
      pageRecordItems(
        items,
        query.data.limit,
        (item) => ({
          at: String(item[table.data.endsWith('_event') ? 'at' : 'updatedAt']),
          id: String(item.id),
        }),
        true,
      ),
    )
  })
  app.post('/v1/workflow-catalogue/draft', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const body = recordWorkflowDraftSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid workflow catalogue draft' }, 400)
    try {
      return context.json(await deps.draftWorkflow({ ...active, ...body.data }))
    } catch (error) {
      return failure(context, error)
    }
  })
  app.post('/v1/workflow-catalogue/import', async (context) => {
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const body = recordWorkflowImportSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid workflow catalogue import' }, 400)
    if (!deps.importWorkflowCatalogue)
      return context.json({ error: 'workflow catalogue import is unavailable' }, 503)
    return context.json(await deps.importWorkflowCatalogue({ ...active, ...body.data }))
  })
  for (const action of ['promote', 'retire'] as const)
    app.post(`/v1/workflow-catalogue/${action}`, async (context) => {
      const active = ports.scope(context)
      if (!active) return ports.noSpace(context)
      const body = recordWorkflowTransitionSchema.safeParse(
        await context.req.json().catch(() => null),
      )
      if (!body.success) return context.json({ error: `invalid workflow catalogue ${action}` }, 400)
      try {
        return context.json(
          await deps[action === 'promote' ? 'promoteWorkflow' : 'retireWorkflow']({
            ...active,
            ...body.data,
          }),
        )
      } catch (error) {
        return failure(context, error)
      }
    })
}
