import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import { decideSiteRequest } from './decision.ts'

const APP_ORIGIN = `https://app.${PLATFORM_SLUG}.run`

async function forward(request: Request, target: URL) {
  const headers = new Headers(request.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  const upstream = await fetch(target, { method: request.method, headers, redirect: 'manual' })
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete('set-cookie')
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

async function handleRequest(request: Request) {
  const source = new URL(request.url)
  const target = new URL(`${source.pathname}${source.search}`, APP_ORIGIN)
  switch (decideSiteRequest(request.method, source.pathname)) {
    case 'forward':
      return forward(request, target)
    case 'redirect':
      return Response.redirect(target, 307)
    case 'refuse':
      return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
}

export default { fetch: handleRequest }
