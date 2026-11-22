// concern: record-api-secret-mask
/** Installs the value-free warning scope and fail-closed hosted write mask at the API edge. */
import type { Context, Env, Hono } from 'hono'
import {
  hostedWriteRouteEntry,
  maskHostedRoutePayload,
  withHostedMaskWarnings,
} from '../../../shared/hosted-secret-mask.ts'
import { RECORD_SYNC_MAX_REQUEST_BYTES } from './record-sync-contract.ts'

const SNAPSHOT_MAX_REQUEST_BYTES = 1024 * 1024

function byteCapRefusal(context: Context, bytes: number) {
  if (context.req.path.startsWith('/v1/snapshots/') && bytes > SNAPSHOT_MAX_REQUEST_BYTES)
    return context.json(
      { error: `snapshot payload exceeds ${SNAPSHOT_MAX_REQUEST_BYTES} bytes` },
      413,
    )
  if (context.req.path === '/v1/sync' && bytes > RECORD_SYNC_MAX_REQUEST_BYTES)
    return context.json(
      {
        error: `record sync request exceeds ${RECORD_SYNC_MAX_REQUEST_BYTES} bytes`,
        remedy: 'send a batch within the hosted sync limits, then retry `bottega record sync`',
      },
      413,
    )
  return null
}

async function installMaskedBody(context: Context) {
  const entry = hostedWriteRouteEntry(context.req.method, context.req.path)
  if (!entry) return null
  if (entry.kind !== 'mask') return null
  const source = new Uint8Array(await context.req.raw.arrayBuffer())
  const refusal = byteCapRefusal(context, source.byteLength)
  if (refusal) return refusal
  context.req.raw = new Request(context.req.raw, { body: source })
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(source))
  } catch {
    return null
  }
  const body = JSON.stringify(maskHostedRoutePayload(context.req.method, context.req.path, parsed))
  context.req.raw = new Request(context.req.raw, { body })
  return null
}

export function registerRecordSecretMask<Environment extends Env>(app: Hono<Environment>): void {
  app.use('/v1/*', async (context, next) => {
    context.res = await withHostedMaskWarnings(async () => {
      if (['POST', 'PUT', 'PATCH'].includes(context.req.method)) {
        const refusal = await installMaskedBody(context)
        if (refusal) return refusal
      }
      await next()
      return context.res
    })
  })
}
