// concern: record-api-mask-warnings
/** Carries value-free masking warnings from hosted writers to HTTP callers. */
import type { Env, Hono } from 'hono'
import { withHostedMaskWarnings } from '../../../shared/hosted-secret-mask.ts'

export function registerRecordMaskWarnings<Environment extends Env>(app: Hono<Environment>): void {
  app.use('/v1/*', async (context, next) => {
    context.res = await withHostedMaskWarnings(async () => {
      await next()
      return context.res
    })
  })
}
