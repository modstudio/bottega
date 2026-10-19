import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { SQL } from 'bun'
import { readBuiltCommit } from '../../shared/built-commit.ts'
import { appStaticPath, resolveAppStatic } from './app-static.ts'
import { changeApi } from './change-api.ts'
import { hostedHealthResponse } from './hosted-health.ts'
import type { HostedRouteConfig } from './hosted-route-config.ts'
import { hostedVersionResponse } from './hosted-version.ts'
import { noteApi } from './note-api.ts'
import { operatorWaitingEmailApi } from './operator-waiting-email-api.ts'
import { reportApi } from './report-api.ts'
import { taskApi } from './task-api.ts'
import { createContext } from './trpc/context.ts'
import { hostedRouter } from './trpc/hosted-router.ts'

type ServerEnvironment = Record<string, string | undefined>
type HostedRouteDependencies = {
  changes?: Parameters<typeof changeApi>[2]
  tasks?: Parameters<typeof taskApi>[2]
  notes?: Parameters<typeof noteApi>[2]
  waitingEmail?: Parameters<typeof operatorWaitingEmailApi>[2]
  reports?: Parameters<typeof reportApi>[2]
}

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

export function hostedRequestHandler(
  config: HostedRouteConfig,
  dependencies: HostedRouteDependencies = {},
) {
  const dist = fileURLToPath(new URL('../web/dist', import.meta.url))
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const health = hostedHealthResponse(req)
    if (health) return health
    const version = hostedVersionResponse(req, readBuiltCommit())
    if (version) return version
    const changes = await changeApi(req, config, dependencies.changes)
    if (changes) return changes
    const tasks = await taskApi(req, config, dependencies.tasks)
    if (tasks) return tasks
    const notes = await noteApi(req, config, dependencies.notes)
    if (notes) return notes
    const waitingEmail = await operatorWaitingEmailApi(req, config, dependencies.waitingEmail)
    if (waitingEmail) return waitingEmail
    const reports = await reportApi(req, config, dependencies.reports)
    if (reports) return reports
    if (url.pathname.startsWith('/trpc')) {
      return fetchRequestHandler({
        endpoint: '/trpc',
        req,
        router: hostedRouter,
        createContext: (options) => createContext(options, config.recordDatabaseUrl),
      })
    }
    const resolved = resolveAppStatic(url.pathname, existsSync(dist))
    if (resolved.kind === '503') {
      return new Response('hub/web is not built: cd hub/web && bun run build', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    const file = Bun.file(appStaticPath(dist, resolved))
    if (!(await file.exists())) {
      // The index is checked too: streaming a missing file sends 200 headers
      // first and fails mid-body, which reads as a broken page, not an error.
      return resolved.kind === 'file'
        ? new Response('not found', { status: 404 })
        : new Response('hub/web is not built: cd hub/web && bun run build', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
    }
    return new Response(file)
  }
}

function startHostedServer(environment: ServerEnvironment = process.env) {
  const config = hostedServerConfig(environment)
  const recordDatabase = new SQL(config.recordDatabaseUrl)
  const routeConfig = { recordApiUrl: config.recordApiUrl, recordDatabaseUrl: recordDatabase }
  const fetch = hostedRequestHandler(routeConfig)
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch,
  })
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await server.stop(false)
    await recordDatabase.close()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, async () => {
      await shutdown()
      process.exit(0)
    })
  console.log(`hub hosted serving on http://${config.hostname}:${server.port}`)
  return server
}

if (import.meta.main) startHostedServer()
