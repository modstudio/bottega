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

export type PublicMarkdownPath =
  | { kind: 'slug'; slug: string }
  | { kind: 'article'; scope: string; subject: string; slug: string }

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

export function publicDocPath(doc: PublicTextDoc, markdown = false): string | null {
  if (doc.subject === null) return null
  return `/docs/${encoded(doc.scope)}/${encoded(doc.subject)}/${encoded(doc.slug)}${markdown ? '.md' : ''}`
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
    if (!path) continue
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

export function parsePublicMarkdownPath(pathname: string): PublicMarkdownPath | null {
  if (!pathname.startsWith('/docs/') || !pathname.endsWith('.md')) return null
  const segments = pathname.slice('/docs/'.length, -'.md'.length).split('/')
  if (segments.length !== 1 && segments.length !== 3) return null
  const values = segments.map(decoded)
  if (values.some((value) => !value)) return null
  if (values.length === 1) return { kind: 'slug', slug: values[0]! }
  return { kind: 'article', scope: values[0]!, subject: values[1]!, slug: values[2]! }
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
  const segments = pathname.split('/').filter(Boolean)
  const canCarryMarkdown = pathname !== '/docs' && !pathname.endsWith('/')
  const alternateHref = segments.length === 4 && canCarryMarkdown ? `${pathname}.md` : null
  const markdown = `${pathname}.md`
  const direction = canCarryMarkdown
    ? `Read it as Markdown at <a href="${escapeHtml(markdown)}">${escapeHtml(markdown)}</a>; every public page is listed at `
    : 'Every public page is listed at '
  return {
    noscript: `<noscript>This page needs JavaScript. ${direction}<a href="/llms.txt">/llms.txt</a>.</noscript>`,
    alternateHref,
  }
}
