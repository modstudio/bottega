// concern: record-api-secret-mask
/** Installs the value-free warning scope and fail-closed hosted write mask at the API edge. */
import type { Hono } from 'hono'
import {
  maskHostedRoutePayload,
  withHostedMaskWarnings,
} from '../../../shared/hosted-secret-mask.ts'

export function registerRecordSecretMask(app: Hono): void {
  app.use('/v1/*', async (context, next) => {
    context.res = await withHostedMaskWarnings(async () => {
      if (['POST', 'PUT', 'PATCH'].includes(context.req.method)) {
        const read = context.req.json.bind(context.req)
        Object.defineProperty(context.req, 'json', {
          configurable: true,
          value: async () =>
            maskHostedRoutePayload(
              context.req.method,
              context.req.path,
              await read().catch(() => null),
            ),
        })
      }
      await next()
      return context.res
    })
  })
}
