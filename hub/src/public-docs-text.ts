import { PLATFORM_NAME, PUBLIC_SITE_ORIGIN } from '../../shared/brand.ts'

export type PublicTextDoc = {
  id: string
  slug: string
  title: string
  parentId: string | null
  position: number
  scope: string
  subject: string | null
  summary?: string
}

export type PublicDocsRequest =
  | { kind: 'llms' }
  | { kind: 'llms-full' }
  | { kind: 'short'; slug: string }
  | { kind: 'markdown-slug'; slug: string }
  | { kind: 'markdown-article'; scope: string; subject: string | null; slug: string }

export type DocsHtmlInsert = { noscript: string; alternateHref: string | null }

const INTRO =
  'Orchestration beneath your coding harness: delegate implementation to agents under a contract, then review and score what they build.'

const byPosition = (left: PublicTextDoc, right: PublicTextDoc) =>
  left.position - right.position ||
  left.title.localeCompare(right.title) ||
  left.id.localeCompare(right.id)

function descendants(parentId: string, children: Map<string, PublicTextDoc[]>): PublicTextDoc[] {
  return (children.get(parentId) ?? []).flatMap((child) => [
    child,
    ...descendants(child.id, children),
  ])
}

export function orderedPublicDocs(items: readonly PublicTextDoc[]): PublicTextDoc[] {
  const children = new Map<string, PublicTextDoc[]>()
  for (const item of items) {
    if (item.parentId === null) continue
    const siblings = children.get(item.parentId) ?? []
    siblings.push(item)
    children.set(item.parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort(byPosition)
  return items
    .filter((item) => item.parentId === null)
    .sort(byPosition)
    .flatMap((item) => [item, ...descendants(item.id, children)])
}

function encoded(value: string): string {
  return encodeURIComponent(value)
}

export function publicDocPath(doc: PublicTextDoc, markdown = false): string {
  // Mirrors hub/data/src/docs/location.ts:docsLocation for subject-less docs.
  const subject = doc.subject ?? '_'
  return `/docs/${encoded(doc.scope)}/${encoded(subject)}/${encoded(doc.slug)}${markdown ? '.md' : ''}`
}

export function renderLlmsTxt(items: readonly PublicTextDoc[]): string {
  const ordered = orderedPublicDocs(items)
  const lines = [
    `# ${PLATFORM_NAME}`,
    '',
    `> ${INTRO}`,
    '',
    `Every page below is plain Markdown. The full set in one file: ${PUBLIC_SITE_ORIGIN}/llms-full.txt`,
  ]
  for (const doc of ordered) {
    const path = publicDocPath(doc, true)
    if (doc.parentId === null) lines.push('', `## ${doc.title}`, '')
    lines.push(
      `- [${doc.title}](${PUBLIC_SITE_ORIGIN}${path})${doc.summary ? `: ${doc.summary}` : ''}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export function uniquePublicDocBySlug(
  items: readonly PublicTextDoc[],
  slug: string,
): PublicTextDoc | null {
  const matches = items.filter((item) => item.slug === slug)
  return matches.length === 1 ? matches[0]! : null
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function parsePublicDocsRequest(pathname: string): PublicDocsRequest | null {
  if (pathname === '/llms.txt') return { kind: 'llms' }
  if (pathname === '/llms-full.txt') return { kind: 'llms-full' }
  if (!pathname.startsWith('/docs/')) return null

  const markdown = pathname.endsWith('.md')
  const suffix = markdown ? pathname.slice('/docs/'.length, -'.md'.length) : pathname.slice(6)
  const segments = suffix.split('/')
  if ((!markdown && segments.length !== 1) || (markdown && ![1, 3].includes(segments.length)))
    return null
  const values = segments.map(decoded)
  if (values.some((value) => !value)) return null
  if (!markdown) return { kind: 'short', slug: values[0]! }
  if (values.length === 1) return { kind: 'markdown-slug', slug: values[0]! }
  return {
    kind: 'markdown-article',
    scope: values[0]!,
    subject: values[1] === '_' ? null : values[1]!,
    slug: values[2]!,
  }
}

export function rewritePublicDocLinks(body: string): string {
  return body.replace(
    /\]\(\.\/([^/#?\s)]+)(#[^\s)]+)?\)/g,
    (_match, slug: string, fragment: string | undefined) =>
      `](${PUBLIC_SITE_ORIGIN}/docs/${slug}.md${fragment ?? ''})`,
  )
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function docsHtmlInsert(pathname: string): DocsHtmlInsert | null {
  if (pathname !== '/docs' && !pathname.startsWith('/docs/')) return null
  const markdown = parsePublicDocsRequest(`${pathname}.md`)
  const article = markdown?.kind === 'markdown-article'
  const alternateHref = article ? `${pathname}.md` : null
  const markdownPath = `${pathname}.md`
  const direction = article
    ? `Read it as Markdown at <a href="${escapeHtml(markdownPath)}">${escapeHtml(markdownPath)}</a>; every public page is listed at `
    : 'Every public page is listed at '
  return {
    noscript: `<noscript>This page needs JavaScript. ${direction}<a href="/llms.txt">/llms.txt</a>.</noscript>`,
    alternateHref,
  }
}
