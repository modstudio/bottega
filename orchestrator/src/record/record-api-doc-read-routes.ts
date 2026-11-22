// concern: record-api-document-read-routes
/** Registers id-keyed hosted document and revision reads. */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { DOC_AUDIENCES, type DocAudience } from '../../../shared/docs.ts'
import { idSchema } from './record-api-wire.ts'
import type { RecordWriteTelemetryEnvironment } from './record-api-write-telemetry.ts'
import type { ConfigTenant } from './record-config.ts'
import type { RecordDoc, RecordDocRevision } from './record-docs.ts'

type Environment = RecordWriteTelemetryEnvironment
type Tenant = Omit<ConfigTenant, 'spaceIds'> & { spaceIds: string[]; uuidKeyedRead?: true }

type Deps = {
  readDoc(input: Tenant & { id: string; audience?: DocAudience }): Promise<RecordDoc | null>
  readDocRevision(
    input: Tenant & { id: string; audience?: DocAudience },
  ): Promise<RecordDocRevision | null>
  listDocRevisions(
    input: Tenant & { id: string; audience?: DocAudience },
  ): Promise<RecordDocRevision[] | null>
}

type Ports = {
  scope(context: Context<Environment>, acrossReadableSpaces?: boolean): Tenant | null
  docIdScope(context: Context<Environment>, id: string): Promise<Tenant | null>
  noSpace(context: Context<Environment>): Response
  writeError(context: Context<Environment>, error: unknown): Response
}

const audience = (context: Context<Environment>) =>
  z.enum(DOC_AUDIENCES).optional().safeParse(context.req.query('audience'))

export function registerRecordDocReadRoutes(
  app: Hono<Environment>,
  deps: Deps,
  ports: Ports,
): void {
  app.get('/v1/docs/:id', async (context) => {
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const tenant = await ports.docIdScope(context, id.data)
    if (!tenant) return ports.noSpace(context)
    const selectedAudience = audience(context)
    if (!selectedAudience.success) return context.json({ error: 'invalid doc audience' }, 400)
    const doc = await deps.readDoc({
      ...tenant,
      id: id.data,
      audience: selectedAudience.data,
    })
    return doc ? context.json(doc) : context.json({ error: 'doc not found' }, 404)
  })
  app.get('/v1/docs/:id/revisions', async (context) => {
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const tenant = await ports.docIdScope(context, id.data)
    if (!tenant) return ports.noSpace(context)
    const selectedAudience = audience(context)
    if (!selectedAudience.success) return context.json({ error: 'invalid doc audience' }, 400)
    try {
      const items = await deps.listDocRevisions({
        ...tenant,
        id: id.data,
        audience: selectedAudience.data,
      })
      return items ? context.json({ items }) : context.json({ error: 'doc not found' }, 404)
    } catch (error) {
      return ports.writeError(context, error)
    }
  })
  app.get('/v1/doc-revisions/:revisionId', async (context) => {
    const id = idSchema.safeParse(context.req.param('revisionId'))
    if (!id.success) return context.json({ error: 'doc revision id must be a uuid' }, 400)
    const readable = ports.scope(context, true)
    if (!readable) return ports.noSpace(context)
    const selectedAudience = audience(context)
    if (!selectedAudience.success) return context.json({ error: 'invalid doc audience' }, 400)
    const found = await deps.readDocRevision({
      ...readable,
      id: id.data,
      audience: selectedAudience.data,
    })
    if (!found) return context.json({ error: 'doc revision not found' }, 404)
    const tenant = await ports.docIdScope(context, found.docId)
    if (!tenant) return ports.noSpace(context)
    const revision = await deps.readDocRevision({
      ...tenant,
      id: id.data,
      audience: selectedAudience.data,
    })
    return revision
      ? context.json(revision)
      : context.json({ error: 'doc revision not found' }, 404)
  })
}
