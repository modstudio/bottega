// concern: record-api-access
/** Registers health and authentication routes. Must not know record data services. */
import type { Env, Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  RECORD_CLIENT_ADDRESSES_PATH,
  type RecordClientAddresses,
} from '../../../shared/record-client-addresses.ts'

export function registerRecordCors<E extends Env>(app: Hono<E>, origins?: string[]): void {
  if (!origins?.length) return
  const allowed = new Set(origins)
  const options = {
    origin: (origin: string) => (allowed.has(origin) ? origin : undefined),
    credentials: true,
    allowHeaders: ['Authorization', 'Content-Type', 'X-Record-Space'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }
  app.use('/v1/*', cors(options))
  app.use('/public/v1/*', cors(options))
  app.use('/api/auth/*', cors(options))
}

type AccessRouteDeps = {
  clientAddresses: RecordClientAddresses
  auth: { handler(request: Request): Response | Promise<Response> }
  readHealth(): Promise<{ ok: boolean; migrations: number }>
  readVersion(): { status: 200 | 503; body: object }
}

export function registerRecordAccessRoutes<E extends Env>(
  app: Hono<E>,
  deps: AccessRouteDeps,
): void {
  app.get('/health', async (context) => {
    const health = await deps.readHealth()
    return context.json(health, health.ok ? 200 : 503)
  })
  app.get('/version', (context) => {
    const response = deps.readVersion()
    return context.json(response.body, response.status)
  })
  app.get(RECORD_CLIENT_ADDRESSES_PATH, (context) => context.json(deps.clientAddresses))
  app.all('/api/auth/*', async (context) => {
    const response = await deps.auth.handler(context.req.raw)
    // A reset request never reveals whether mail was sent or the client-IP limit was reached.
    if (context.req.path === '/api/auth/request-password-reset' && response.status === 429) {
      return context.json({
        status: true,
        message: 'If this email exists in our system, check your email for the reset link',
      })
    }
    return response
  })
}
