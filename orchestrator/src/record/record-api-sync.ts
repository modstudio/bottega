// concern: record-api-sync
/** Validates the bounded sync transport and delegates authenticated evidence ingestion. */
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  RECORD_SYNC_BATCH_SIZE,
  RECORD_SYNC_MAX_PAYLOAD_BYTES,
  RECORD_SYNC_MAX_REQUEST_BYTES,
  type RecordSyncRequest,
  type RecordSyncResponse,
} from './record-sync-contract.ts'
import { RecordSyncRequestRefusal } from './record-sync-decision.ts'

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

const requestRemedy = `send a batch within the hosted sync limits, then retry \`${PLATFORM_SLUG} record sync\``
const payloadRemedy = `repair the oversized local payload or retire its row with \`${PLATFORM_SLUG} record outbox retire orch:<row-id> --reason <text>\`, then retry \`${PLATFORM_SLUG} record sync\``

export function registerRecordSyncRoute(
  app: Hono<SyncEnvironment>,
  deps: RecordSyncRouteDeps,
): void {
  app.post(
    '/v1/sync',
    bodyLimit({
      maxSize: RECORD_SYNC_MAX_REQUEST_BYTES,
      onError: (context) =>
        context.json(
          {
            error: `record sync request exceeds ${RECORD_SYNC_MAX_REQUEST_BYTES} bytes`,
            remedy: requestRemedy,
          },
          413,
        ),
    }),
    async (context) => {
      if (!deps.syncRecord)
        return context.json({ error: 'record sync is not available in this server' }, 501)
      const identity = context.get('identity')
      if (!identity.activeSpaceId) return context.json({ error: RECORD_ACTIVE_SPACE_REMEDY }, 409)
      const source = await context.req.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(source || 'null')
      } catch {
        return context.json({ error: 'invalid record sync request', remedy: requestRemedy }, 400)
      }
      const body = syncSchema.safeParse(parsed)
      if (!body.success) {
        const oversized = body.error.issues.some((issue) => issue.path.at(-1) === 'payload')
        return context.json(
          {
            error: oversized
              ? `record sync payload exceeds ${RECORD_SYNC_MAX_PAYLOAD_BYTES} bytes`
              : 'invalid record sync request',
            remedy: oversized ? payloadRemedy : requestRemedy,
          },
          oversized ? 413 : 400,
        )
      }
      try {
        return context.json(
          await deps.syncRecord({ url: deps.recordUrl, identity, request: body.data }),
        )
      } catch (error) {
        if (error instanceof RecordSyncRequestRefusal) {
          return context.json({ error: error.message }, 409)
        }
        throw error
      }
    },
  )
}
