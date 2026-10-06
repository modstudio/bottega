// concern: record-api-access
/** Registers health and authentication routes. Must not know record data services. */
import type { Env, Hono } from 'hono'

type AccessRouteDeps = {
  auth: { handler(request: Request): Response | Promise<Response> }
  readHealth(): Promise<{ ok: boolean; migrations: number }>
}

export function registerRecordAccessRoutes<E extends Env>(
  app: Hono<E>,
  deps: AccessRouteDeps,
): void {
  app.get('/health', async (context) => {
    const health = await deps.readHealth()
    return context.json(health, health.ok ? 200 : 503)
  })
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
