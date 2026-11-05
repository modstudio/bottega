import { PUBLIC_SITE_ORIGIN } from '../../shared/brand.ts'
import { publicDoc, publicDocsTree } from './public-docs.ts'
import {
  orderedPublicDocs,
  type PublicDocsRequest,
  type PublicTextDoc,
  parsePublicDocsRequest,
  publicDocPath,
  renderLlmsTxt,
  rewritePublicDocLinks,
  uniquePublicDocBySlug,
} from './public-docs-text.ts'

type Dependencies = {
  tree: () => Promise<{ items: PublicTextDoc[] }>
  doc: (id: string) => Promise<{ body: string }>
}

const CACHE_CONTROL = 'public, max-age=300'
const textHeaders = (contentType: string) => ({
  'cache-control': CACHE_CONTROL,
  'content-type': contentType,
})

function response(request: Request, body: string, contentType: string): Response {
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: textHeaders(contentType),
  })
}

function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return new Response(`the public docs could not be read from the record: ${message}`, {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

function matchingDoc(
  items: readonly PublicTextDoc[],
  path: Extract<PublicDocsRequest, { kind: 'markdown-slug' | 'markdown-article' }>,
) {
  if (path.kind === 'markdown-slug') return uniquePublicDocBySlug(items, path.slug)
  return (
    items.find(
      (item) =>
        item.scope === path.scope && item.subject === path.subject && item.slug === path.slug,
    ) ?? null
  )
}

async function mapWithLimit<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  async function worker() {
    while (next < values.length) {
      const index = next++
      results[index] = await operation(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

async function fullText(
  items: readonly PublicTextDoc[],
  read: Dependencies['doc'],
): Promise<string> {
  const docs = orderedPublicDocs(items)
  const bodies = await mapWithLimit(docs, 8, async (doc) =>
    rewritePublicDocLinks((await read(doc.id)).body),
  )
  return `${docs
    .map((doc, index) => `Source: ${PUBLIC_SITE_ORIGIN}${publicDocPath(doc)}\n\n${bodies[index]}`)
    .join('\n\n')}\n`
}

async function textRouteResponse(
  request: Request,
  url: URL,
  route: PublicDocsRequest,
  items: readonly PublicTextDoc[],
  read: Dependencies['doc'],
): Promise<Response | null> {
  if (route.kind === 'llms')
    return response(request, renderLlmsTxt(items), 'text/plain; charset=utf-8')
  if (route.kind === 'llms-full')
    return response(request, await fullText(items, read), 'text/plain; charset=utf-8')
  if (route.kind === 'short') {
    const doc = uniquePublicDocBySlug(items, route.slug)
    const path = doc ? publicDocPath(doc) : null
    return path
      ? new Response(null, { status: 308, headers: { location: `${path}${url.search}` } })
      : null
  }
  const doc = matchingDoc(items, route)
  if (!doc) {
    return new Response(
      `no public doc at ${url.pathname}\nevery public page is listed at /llms.txt`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
  }
  const found = await read(doc.id)
  return response(request, rewritePublicDocLinks(found.body), 'text/markdown; charset=utf-8')
}

export async function publicDocsTextApi(
  request: Request,
  dependencies: Partial<Dependencies> = {},
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  const route = parsePublicDocsRequest(url.pathname)
  if (!route) return null

  const tree = dependencies.tree ?? publicDocsTree
  const read = dependencies.doc ?? publicDoc
  try {
    const { items } = await tree()
    return await textRouteResponse(request, url, route, items, read)
  } catch (error) {
    if (route.kind === 'short') return null
    return failure(error)
  }
}
