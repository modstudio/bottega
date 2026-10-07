export type SiteRequestDecision = 'forward' | 'redirect' | 'refuse'

const PUBLIC_DOCS_PROCEDURES = new Set(['publicDocs.get', 'publicDocs.search', 'publicDocs.tree'])

function isPublicDocsRequest(pathname: string) {
  if (!pathname.startsWith('/trpc/')) return false
  let procedurePath: string
  try {
    procedurePath = decodeURIComponent(pathname.slice('/trpc/'.length))
  } catch {
    return false
  }
  const procedures = procedurePath.split(',')
  return procedures.length > 0 && procedures.every((name) => PUBLIC_DOCS_PROCEDURES.has(name))
}

function isRootStaticFile(pathname: string) {
  return /^\/[^/]+\.[^/]+$/.test(pathname)
}

/** Decide the edge action without reading headers, the network, or Worker state. */
export function decideSiteRequest(method: string, pathname: string): SiteRequestDecision {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return 'refuse'
  if (
    pathname === '/' ||
    pathname.startsWith('/product/') ||
    pathname === '/docs' ||
    pathname.startsWith('/docs/') ||
    pathname.startsWith('/assets/') ||
    isRootStaticFile(pathname) ||
    isPublicDocsRequest(pathname)
  ) {
    return 'forward'
  }
  return 'redirect'
}
