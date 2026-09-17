import { existsSync } from 'node:fs'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { resolveAppStatic } from './app-static.ts'
import { evidenceApi } from './evidence-api.ts'
import { hostedHealthResponse } from './hosted-health.ts'
import { taskApi } from './task-api.ts'
import { createContext } from './trpc/context.ts'
import { hostedRouter } from './trpc/hosted-router.ts'

type ServerEnvironment = Record<string, string | undefined>

export function hostedServerConfig(environment: ServerEnvironment = process.env) {
  const recordApiUrl = environment.HUB_RECORD_API_URL
  if (!recordApiUrl) throw new Error('HUB_RECORD_API_URL is required')
  const recordDatabaseUrl = environment.HUB_RECORD_DATABASE_URL
  if (!recordDatabaseUrl) throw new Error('HUB_RECORD_DATABASE_URL is required')
  const port = Number(environment.PORT ?? '3000')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer from 0 through 65535')
  }
  return { port, hostname: '0.0.0.0', recordApiUrl, recordDatabaseUrl }
}

function startHostedServer(environment: ServerEnvironment = process.env) {
  const config = hostedServerConfig(environment)
  const dist = new URL('../web/dist/', import.meta.url).pathname
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url)
      const health = hostedHealthResponse(req)
      if (health) return health
      const evidence = await evidenceApi(req, config)
      if (evidence) return evidence
      const tasks = await taskApi(req, config)
      if (tasks) return tasks
      if (url.pathname.startsWith('/trpc')) {
        return fetchRequestHandler({
          endpoint: '/trpc',
          req,
          router: hostedRouter,
          createContext,
        })
      }
      const resolved = resolveAppStatic(url.pathname, existsSync(dist))
      if (resolved.kind === '503') {
        return new Response('hub/web is not built: cd hub/web && bun run build', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
      const file = Bun.file(dist + resolved.relativePath)
      if (resolved.kind === 'file' && !(await file.exists())) {
        return new Response('not found', { status: 404 })
      }
      return new Response(file)
    },
  })
  console.log(`hub hosted serving on http://${config.hostname}:${server.port}`)
  return server
}

if (import.meta.main) startHostedServer()
