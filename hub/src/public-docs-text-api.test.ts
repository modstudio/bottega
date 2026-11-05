import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { PublicTextDoc } from './public-docs-text.ts'
import { publicDocsTextApi } from './public-docs-text-api.ts'

const install: PublicTextDoc = {
  id: 'install-id',
  slug: 'install',
  title: 'Install',
  parentId: null,
  position: 1,
  scope: 'project',
  subject: PLATFORM_SLUG,
  summary: 'Install the tool',
}

const dependencies = {
  tree: async () => ({ items: [install] }),
  doc: async () => ({ body: '# Install\n\nRun the installer.' }),
}
const articlePath = `/docs/project/${PLATFORM_SLUG}/install`

describe('public docs text API', () => {
  test('serves llms.txt as cached plain text', async () => {
    const response = await publicDocsTextApi(
      new Request('https://hub.example.test/llms.txt'),
      dependencies,
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response?.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await response?.text()).toContain('[Install]')
  })

  test('serves an article Markdown body', async () => {
    const response = await publicDocsTextApi(
      new Request(`https://hub.example.test${articlePath}.md`),
      dependencies,
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await response?.text()).toBe('# Install\n\nRun the installer.')
  })

  test('redirects a unique short address relatively and keeps its query', async () => {
    const response = await publicDocsTextApi(
      new Request('https://hub.example.test/docs/install?source=reader'),
      dependencies,
    )
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe(`${articlePath}?source=reader`)
  })

  test('lets the SPA handle an ambiguous short address', async () => {
    const response = await publicDocsTextApi(new Request('https://hub.example.test/docs/install'), {
      ...dependencies,
      tree: async () => ({ items: [install, { ...install, id: 'other', subject: 'other' }] }),
    })
    expect(response).toBeNull()
  })

  test('returns a remedial 404 for an unknown Markdown path', async () => {
    const response = await publicDocsTextApi(
      new Request(`https://hub.example.test/docs/project/${PLATFORM_SLUG}/missing.md`),
      dependencies,
    )
    expect(response?.status).toBe(404)
    expect(await response?.text()).toBe(
      `no public doc at /docs/project/${PLATFORM_SLUG}/missing.md\nevery public page is listed at /llms.txt`,
    )
  })

  test('returns 502 when the public record cannot be read', async () => {
    const response = await publicDocsTextApi(new Request('https://hub.example.test/llms.txt'), {
      ...dependencies,
      tree: async () => {
        throw new Error('record unavailable')
      },
    })
    expect(response?.status).toBe(502)
    expect(await response?.text()).toBe(
      'the public docs could not be read from the record: record unavailable',
    )
  })

  test('does not handle POST', async () => {
    expect(
      await publicDocsTextApi(
        new Request('https://hub.example.test/llms.txt', { method: 'POST' }),
        dependencies,
      ),
    ).toBeNull()
  })
})
