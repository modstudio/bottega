// concern: record-api-workflow
/** Exposes validated tenant-bound workflow catalogue routes. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { renderRecordApiRefusal } from './record-api-errors.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  decodeRecordCursor,
  pageRecordItems,
  type RecordCursor,
  type RecordListCursorRow,
  recordCursorOf,
} from './record-cursor.ts'
import { RecordTaskFlowError } from './record-task-flow.ts'
import {
  type TaskFlowIntent,
  type TaskFlowIntentInput,
  taskFlowIntentSchemas,
} from './record-task-flow-write-contract.ts'
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
  readTaskFlow?(input: Tenant & { taskKey?: string; flowRecordId?: string }): Promise<unknown>
  writeTaskFlow?<K extends TaskFlowIntent>(
    intent: K,
    input: Tenant & TaskFlowIntentInput<K>,
  ): Promise<unknown>
  listWorkflowCatalogue(
    input: Tenant & { table: RecordWorkflowTable; limit: number; cursor: RecordCursor | null },
  ): Promise<(Record<string, unknown> & RecordListCursorRow)[]>
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

function registerTaskFlowWriteRoutes(
  app: Hono<Environment>,
  deps: RecordWorkflowRouteDeps,
  ports: Ports,
): void {
  for (const intent of Object.keys(taskFlowIntentSchemas) as TaskFlowIntent[])
    app.post(`/v1/task-flow/${intent}`, async (context) => {
      if (!deps.writeTaskFlow)
        return context.json({ error: 'hosted task flow write is unavailable' }, 503)
      const active = ports.scope(context)
      if (!active) return ports.noSpace(context)
      const body = taskFlowIntentSchemas[intent].safeParse(
        await context.req.json().catch(() => null),
      )
      if (!body.success) return context.json({ error: `invalid task-flow ${intent} request` }, 400)
      try {
        return context.json(await deps.writeTaskFlow(intent, { ...active, ...body.data } as never))
      } catch (error) {
        if (error instanceof DocRevisionConflictError)
          return renderRecordApiRefusal(context, error)!
        throw error
      }
    })
}

export function registerRecordWorkflowRoutes(
  app: Hono<Environment>,
  deps: RecordWorkflowRouteDeps,
  ports: Ports,
): void {
  const failure = (context: Context<Environment>, error: unknown) => {
    if (error instanceof DocRevisionConflictError) return renderRecordApiRefusal(context, error)!
    return error instanceof RecordWorkflowError
      ? context.json({ error: error.message }, error.status as 404 | 409 | 422)
      : (() => {
          throw error
        })()
  }
  app.get('/v1/task-flow', async (context) => {
    if (!deps.readTaskFlow)
      return context.json({ error: 'hosted task flow read is unavailable' }, 503)
    const active = ports.scope(context)
    if (!active) return ports.noSpace(context)
    const query = z
      .object({ taskKey: z.string().min(1).optional(), flowRecordId: z.string().uuid().optional() })
      .refine((value) => Number(Boolean(value.taskKey)) + Number(Boolean(value.flowRecordId)) === 1)
      .safeParse(context.req.query())
    if (!query.success)
      return context.json({ error: 'pass exactly one taskKey or flowRecordId' }, 400)
    try {
      return context.json(await deps.readTaskFlow({ ...active, ...query.data }))
    } catch (error) {
      if (error instanceof RecordTaskFlowError)
        return context.json({ error: error.message, code: error.code }, 404)
      throw error
    }
  })
  registerTaskFlowWriteRoutes(app, deps, ports)
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
    return context.json(pageRecordItems(items, query.data.limit, recordCursorOf, true))
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
  app.post('/v1/workflow-catalogue/import/v2', async (context) => {
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
