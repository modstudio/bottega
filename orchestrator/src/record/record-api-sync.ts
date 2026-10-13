// concern: record-api-sync
/** Validates the bounded sync transport and delegates authenticated evidence ingestion. */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'
import {
  RECORD_SYNC_BATCH_SIZE,
  RECORD_SYNC_MAX_PAYLOAD_BYTES,
  RECORD_SYNC_MAX_REQUEST_BYTES,
  type RecordSyncRequest,
  type RecordSyncResponse,
} from './record-sync-contract.ts'

type SyncEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }

export type RecordSyncRouteDeps = {
  recordUrl: string
  syncRecord?(input: {
    url: string
    identity: RecordIdentity
    request: RecordSyncRequest
  }): Promise<RecordSyncResponse>
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const payloadSchema = z.string().refine((value) => bytes(value) <= RECORD_SYNC_MAX_PAYLOAD_BYTES)
const syncSchema = z.object({
  machine: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    seenAt: z.string().datetime({ offset: true }),
  }),
  rows: z
    .array(
      z.object({
        id: z.number().int().positive(),
        kind: z.string().min(1),
        payload: payloadSchema,
        spaceHint: z.string().min(1).nullable(),
      }),
    )
    .max(RECORD_SYNC_BATCH_SIZE),
})

const releaseRemedy =
  'release the hosted record API with matching sync limits, then retry `orch sync`'

export function registerRecordSyncRoute(
  app: Hono<SyncEnvironment>,
  deps: RecordSyncRouteDeps,
): void {
  app.post('/v1/sync', async (context) => {
    if (!deps.syncRecord)
      return context.json({ error: 'record sync is not available in this server' }, 501)
    const source = await context.req.text()
    if (bytes(source) > RECORD_SYNC_MAX_REQUEST_BYTES) {
      return context.json(
        {
          error: `record sync request exceeds ${RECORD_SYNC_MAX_REQUEST_BYTES} bytes`,
          remedy: releaseRemedy,
        },
        413,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source || 'null')
    } catch {
      return context.json({ error: 'invalid record sync request', remedy: releaseRemedy }, 400)
    }
    const body = syncSchema.safeParse(parsed)
    if (!body.success) {
      const oversized = body.error.issues.some((issue) => issue.path.at(-1) === 'payload')
      return context.json(
        {
          error: oversized
            ? `record sync payload exceeds ${RECORD_SYNC_MAX_PAYLOAD_BYTES} bytes`
            : 'invalid record sync request',
          remedy: releaseRemedy,
        },
        oversized ? 413 : 400,
      )
    }
    return context.json(
      await deps.syncRecord({
        url: deps.recordUrl,
        identity: context.get('identity'),
        request: body.data,
      }),
    )
  })
}
