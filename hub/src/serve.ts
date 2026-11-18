import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { releaseLease, watch } from './collect.ts'
import { db, enableSchemaReload } from './db.ts'
import { localAppStaticResponse } from './local-app-static.ts'
import { LOCAL_LOGIN_MESSAGE, LocalHubAuth } from './local-auth.ts'
import { clearOrchCache } from './orch-view.ts'
import { startRevisionMonitor } from './service-revision.ts'
import { createContext } from './trpc/context.ts'
import { appRouter } from './trpc/router.ts'

const SERVE_DRAIN_MS = 5_000
const localAuth = new LocalHubAuth()

/** Browser mutations must prove they came from the page served by this hub. */
export function trpcMutationRequestAllowed(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return true
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  return origin === new URL(request.url).origin || fetchSite === 'same-origin'
}

export function handleTrpcRequest(
  request: Request,
  auth: Pick<LocalHubAuth, 'allows'> = localAuth,
): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/trpc',
    req: request,
    router: appRouter,
    createContext(options) {
      if (request.method.toUpperCase() === 'POST' && !auth.allows(request)) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: LOCAL_LOGIN_MESSAGE })
      }
      if (!trpcMutationRequestAllowed(request)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'cross-origin tRPC mutation refused' })
      }
      return createContext(options)
    },
    // A write can change anything an orchestrator read returned, so the next read starts fresh.
    responseMeta({ type }) {
      if (type === 'mutation') clearOrchCache()
      return {}
    },
  })
}

export function serve(port: number) {
  // Not started for an ephemeral port: server tests spin one up and down, and
  // should test responses rather than spend seconds collecting.
  //
  // The lease means this is safe beside the launchd daemon: whichever holds it
  // collects, the other waits, and neither has to know the other exists.
  const holder = `serve:${process.pid}`
  const stopWatch = port !== 0 ? watch(holder) : async () => {}
  enableSchemaReload((from, to) => {
    console.log(`schema changed: reloading query layer (user_version ${from} -> ${to})`)
  })

  const server = Bun.serve({
    // Long queries can outlast Bun's default idle timeout. 255s is Bun's ceiling.
    idleTimeout: 255,
    port,
    // Loopback only. This page carries a per-task record of everything this
    // machine works on across five private repos. Mutations require both a
    // same-origin browser request and a valid local login session.
    hostname: '127.0.0.1',
    async fetch(req) {
      db()
      const url = new URL(req.url)

      if (url.pathname === '/login') return localAuth.exchange(req)

      if (url.pathname.startsWith('/trpc')) {
        return handleTrpcRequest(req)
      }

      if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
        const target = url.pathname.slice('/app'.length) || '/'
        return Response.redirect(new URL(target + url.search, url), 301)
      }

      return localAppStaticResponse(url.pathname)
    },
  })
  if (port !== 0) {
    startRevisionMonitor(
      'serve',
      holder,
      async () => {
        const drained = server.stop(false)
        await Promise.race([drained, Bun.sleep(SERVE_DRAIN_MS)])
        server.stop(true)
        await stopWatch()
      },
      () => releaseLease(holder),
    )
  }
  console.log(`hub serving on http://127.0.0.1:${server.port}`)
  return server
}
