import { PUBLIC_SITE_ORIGIN } from '../../shared/brand.ts'
import { publicDoc, publicDocsTree } from './public-docs.ts'
import {
  orderedPublicDocs,
  type PublicTextDoc,
  parsePublicMarkdownPath,
  publicDocPath,
  renderLlmsTxt,
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
  path: ReturnType<typeof parsePublicMarkdownPath>,
) {
  if (!path) return null
  if (path.kind === 'slug') return uniquePublicDocBySlug(items, path.slug)
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
  const docs = orderedPublicDocs(items).filter((item) => publicDocPath(item) !== null)
  const bodies = await mapWithLimit(docs, 8, async (doc) => (await read(doc.id)).body)
  return `${docs
    .map((doc, index) => `Source: ${PUBLIC_SITE_ORIGIN}${publicDocPath(doc)}\n\n${bodies[index]}`)
    .join('\n\n')}\n`
}

export async function publicDocsTextApi(
  request: Request,
  dependencies: Partial<Dependencies> = {},
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  const markdownPath = parsePublicMarkdownPath(url.pathname)
  const shortMatch = /^\/docs\/([^/]+)$/.exec(url.pathname)
  const recognized =
    url.pathname === '/llms.txt' ||
    url.pathname === '/llms-full.txt' ||
    (url.pathname.startsWith('/docs/') && url.pathname.endsWith('.md')) ||
    shortMatch
  if (!recognized) return null

  const tree = dependencies.tree ?? publicDocsTree
  const read = dependencies.doc ?? publicDoc
  try {
    const { items } = await tree()
    if (url.pathname === '/llms.txt')
      return response(request, renderLlmsTxt(items), 'text/plain; charset=utf-8')
    if (url.pathname === '/llms-full.txt')
      return response(request, await fullText(items, read), 'text/plain; charset=utf-8')
    if (shortMatch && !url.pathname.endsWith('.md')) {
      const slug = decoded(shortMatch[1]!)
      const doc = slug ? uniquePublicDocBySlug(items, slug) : null
      const path = doc ? publicDocPath(doc) : null
      if (!path) return null
      return new Response(null, {
        status: 308,
        headers: { location: `${path}${url.search}` },
      })
    }
    const doc = matchingDoc(items, markdownPath)
    if (!doc) {
      return new Response(
        `no public doc at ${url.pathname}\nevery public page is listed at /llms.txt`,
        { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      )
    }
    const found = await read(doc.id)
    return response(request, found.body, 'text/markdown; charset=utf-8')
  } catch (error) {
    return failure(error)
  }
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
