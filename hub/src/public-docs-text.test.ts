import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG, PUBLIC_SITE_ORIGIN } from '../../shared/brand.ts'
import {
  docsHtmlInsert,
  orderedPublicDocs,
  type PublicTextDoc,
  parsePublicMarkdownPath,
  renderLlmsTxt,
  uniquePublicDocBySlug,
} from './public-docs-text.ts'

const docs: PublicTextDoc[] = [
  {
    id: 'start',
    slug: 'getting-started',
    title: 'Getting started',
    parentId: null,
    position: 2,
    scope: 'project',
    subject: PLATFORM_SLUG,
    summary: 'Begin here',
  },
  {
    id: 'install',
    slug: 'install',
    title: 'Install',
    parentId: 'start',
    position: 2,
    scope: 'project',
    subject: PLATFORM_SLUG,
    summary: '',
  },
  {
    id: 'first',
    slug: 'first-job',
    title: 'First job',
    parentId: 'start',
    position: 1,
    scope: 'project',
    subject: PLATFORM_SLUG,
    summary: 'Delegate a job',
  },
  {
    id: 'nested',
    slug: 'review',
    title: 'Review',
    parentId: 'first',
    position: 1,
    scope: 'project',
    subject: PLATFORM_SLUG,
    summary: 'Review the result',
  },
  {
    id: 'concepts',
    slug: 'concepts',
    title: 'Concepts',
    parentId: null,
    position: 1,
    scope: 'project',
    subject: PLATFORM_SLUG,
    summary: 'Understand the model',
  },
]

describe('public docs text decisions', () => {
  test('orders sections and their descendants depth-first by position', () => {
    expect(orderedPublicDocs(docs).map((doc) => doc.id)).toEqual([
      'concepts',
      'start',
      'first',
      'nested',
      'install',
    ])
  })

  test('renders llms.txt sections, links, summaries, and an empty summary', () => {
    const text = renderLlmsTxt(docs)
    expect(text).toStartWith(`# ${PLATFORM_NAME}\n\n>`)
    expect(text).toContain(
      `## Getting started\n\n- [Getting started](${PUBLIC_SITE_ORIGIN}/docs/project/${PLATFORM_SLUG}/getting-started.md): Begin here`,
    )
    expect(text).toContain(
      `- [First job](${PUBLIC_SITE_ORIGIN}/docs/project/${PLATFORM_SLUG}/first-job.md): Delegate a job`,
    )
    expect(text).toContain(
      `- [Install](${PUBLIC_SITE_ORIGIN}/docs/project/${PLATFORM_SLUG}/install.md)\n`,
    )
    expect(text).not.toContain('install.md):')
  })

  test('resolves only a unique slug', () => {
    expect(uniquePublicDocBySlug(docs, 'install')?.id).toBe('install')
    expect(uniquePublicDocBySlug([...docs, { ...docs[1]!, id: 'other' }], 'install')).toBeNull()
    expect(uniquePublicDocBySlug(docs, 'missing')).toBeNull()
  })

  test('parses only one- and three-segment Markdown paths', () => {
    expect(parsePublicMarkdownPath('/docs/install.md')).toEqual({ kind: 'slug', slug: 'install' })
    expect(parsePublicMarkdownPath(`/docs/project/${PLATFORM_SLUG}/install.md`)).toEqual({
      kind: 'article',
      scope: 'project',
      subject: PLATFORM_SLUG,
      slug: 'install',
    })
    expect(parsePublicMarkdownPath('/docs/project/install.md')).toBeNull()
    expect(parsePublicMarkdownPath(`/docs/project/${PLATFORM_SLUG}/install`)).toBeNull()
  })

  test('describes the HTML inserts for the index, short path, and article path', () => {
    expect(docsHtmlInsert('/docs')).toEqual({
      noscript:
        '<noscript>This page needs JavaScript. Every public page is listed at <a href="/llms.txt">/llms.txt</a>.</noscript>',
      alternateHref: null,
    })
    expect(docsHtmlInsert('/docs/install')).toEqual({
      noscript:
        '<noscript>This page needs JavaScript. Read it as Markdown at <a href="/docs/install.md">/docs/install.md</a>; every public page is listed at <a href="/llms.txt">/llms.txt</a>.</noscript>',
      alternateHref: null,
    })
    const articlePath = `/docs/project/${PLATFORM_SLUG}/install`
    expect(docsHtmlInsert(articlePath)).toEqual({
      noscript: `<noscript>This page needs JavaScript. Read it as Markdown at <a href="${articlePath}.md">${articlePath}.md</a>; every public page is listed at <a href="/llms.txt">/llms.txt</a>.</noscript>`,
      alternateHref: `${articlePath}.md`,
    })
    expect(docsHtmlInsert('/tasks')).toBeNull()
  })
})
