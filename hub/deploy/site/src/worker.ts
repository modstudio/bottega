import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import { decideSiteRequest } from './decision.ts'

const APP_ORIGIN = `https://app.${PLATFORM_SLUG}.run`

/**
 * The same path and query on the app origin. The parts are assigned rather than resolved as a
 * relative reference, because a path beginning with two slashes resolves to another host.
 */
export function appTarget(source: URL): URL {
  const target = new URL(APP_ORIGIN)
  target.pathname = source.pathname
  target.search = source.search
  return target
}

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
  // The site has one address: the www name answers only to send the visitor to it.
  if (source.hostname.startsWith('www.')) {
    const apex = new URL(source.href)
    apex.hostname = source.hostname.slice('www.'.length)
    return Response.redirect(apex, 301)
  }
  const target = appTarget(source)
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
