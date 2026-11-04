// concern: hosted task-flow API
/** Exposes the keyed tenant read for one flow and its open stage. */
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import { RecordTaskFlowError } from './record-task-flow.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
export type RecordTaskFlowRouteDeps = {
  readTaskFlow(input: Tenant & { taskKey?: string; flowRecordId?: string }): Promise<unknown>
}

export function registerRecordTaskFlowRoutes(
  app: Hono<Environment>,
  deps: RecordTaskFlowRouteDeps,
  ports: {
    scope(context: Context<Environment>): Tenant | null
    noSpace(context: Context<Environment>): Response
  },
): void {
  app.get('/v1/task-flow', async (context) => {
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
      if (error instanceof RecordTaskFlowError) return context.json({ error: error.message }, 404)
      throw error
    }
  })
}
