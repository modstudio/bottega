// concern: record-api-doc-rename
/** Validates and serves the hosted document subject rename edge. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { RecordDocumentTenant } from './record-api-doc-tenant.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }

export function registerRecordDocRenameRoute(
  app: Hono<ApiEnvironment>,
  renameDocSubject: (
    input: RecordDocumentTenant & { from: string; to: string; count: number },
  ) => Promise<{ docs: number; revisions: number }>,
  ports: {
    scope(context: Context<ApiEnvironment>): RecordDocumentTenant | null
    noSpace(context: Context<ApiEnvironment>): Response
    writeError(context: Context<ApiEnvironment>, error: unknown): Response
  },
): void {
  app.post('/v1/docs/rename-subject', async (context) => {
    const tenant = ports.scope(context)
    if (!tenant) return ports.noSpace(context)
    const body = z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        count: z.number().int().nonnegative(),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid subject rename' }, 400)
    try {
      return context.json(await renameDocSubject({ ...tenant, ...body.data }))
    } catch (error) {
      return ports.writeError(context, error)
    }
  })
}
