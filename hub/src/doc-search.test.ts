import { describe, expect, mock, test } from 'bun:test'
import { docSnippet, searchLocalDocs } from './doc-search.ts'

describe('docSnippet', () => {
  test('places a middle match inside a bounded window', () => {
    const result = docSnippet(`${'a'.repeat(100)}Needle${'b'.repeat(100)}`, 'needle')
    expect(result.snippet).toBe(`${'a'.repeat(60)}Needle${'b'.repeat(60)}`)
    expect(result.highlights).toEqual([{ start: 60, length: 6 }])
  })

  test('keeps matches at the start and end', () => {
    expect(docSnippet(`Needle${'b'.repeat(100)}`, 'needle')).toEqual({
      snippet: `Needle${'b'.repeat(60)}`,
      highlights: [{ start: 0, length: 6 }],
    })
    const end = docSnippet(`${'a'.repeat(100)}Needle`, 'needle')
    expect(end).toEqual({
      snippet: `${'a'.repeat(60)}Needle`,
      highlights: [{ start: 60, length: 6 }],
    })
  })

  test('uses the start of the body for title-only and absent matches', () => {
    const body = 'Body without the term.'
    expect(docSnippet(body, 'needle')).toEqual({
      snippet: body,
      highlights: [],
    })
  })

  test('does not split multi-byte code points and reports a usable string position', () => {
    const result = docSnippet(`${'😀'.repeat(70)}NÉÉDLE`, 'néédle')
    expect(result.snippet.startsWith('😀')).toBe(true)
    expect(result.highlights).toEqual([{ start: 120, length: 6 }])
    expect(result.snippet.slice(result.highlights[0]!.start)).toStartWith('NÉÉDLE')
  })

  test('reports an original-text offset when an earlier character expands while folding', () => {
    const result = docSnippet('İfoo', 'foo')
    expect(result).toEqual({ snippet: 'İfoo', highlights: [{ start: 1, length: 3 }] })
    expect(result.snippet.slice(result.highlights[0]!.start)).toBe('foo')
  })

  test('finds a match in plain text after stripping an HTML tag', () => {
    expect(docSnippet('Kept stock<br>for brands', 'br')).toEqual({
      snippet: 'Kept stock for brands',
      highlights: [{ start: 15, length: 2 }],
    })
  })

  test('does not highlight a match that exists only in link syntax', () => {
    expect(docSnippet('see [guide](https://example.com)', 'https')).toEqual({
      snippet: 'see guide',
      highlights: [],
    })
  })
})

test('local search short-circuits an empty query without calling orch', async () => {
  const list = mock(async () => [])
  expect(await searchLocalDocs({ query: '  ' }, list as never)).toEqual([])
  expect(list).not.toHaveBeenCalled()
})

test('local search makes one orch call and excludes a subject-only store match', async () => {
  const base = {
    id: 1,
    scope: 'global' as const,
    subject: null,
    slug: 'guide',
    title: 'Guide',
    body: 'A needle in the body.',
    delivery: 'demand' as const,
    audiences: ['technical'] as ['technical'],
    parent_id: null,
    parent_slug: null,
    position: 0,
    revision: null,
    created_at: '2026-10-06T12:00:00.000Z',
    updated_at: '2026-10-06T12:00:00.000Z',
    status: 'current' as const,
    kind: 'article' as const,
  }
  const list = mock(async () => [base, { ...base, id: 2, body: 'Other.', subject: 'needle' }])
  expect(await searchLocalDocs({ query: 'needle' }, list as never)).toEqual([
    {
      id: '1',
      slug: 'guide',
      title: 'Guide',
      audiences: ['technical'],
      status: 'current',
      kind: 'article',
      snippet: 'A needle in the body.',
      highlights: [{ start: 2, length: 6 }],
    },
  ])
  expect(list).toHaveBeenCalledTimes(1)
  expect(list).toHaveBeenCalledWith({
    scope: undefined,
    subject: undefined,
    audience: undefined,
    status: 'current',
    match: 'needle',
    bodyMatch: 'needle',
  })
})

test('local search includes draft rows only when requested', async () => {
  const list = mock(async (filters: { status?: string }) =>
    filters.status === 'draft'
      ? [
          {
            id: 2,
            slug: 'draft-guide',
            title: 'Draft guide',
            body: 'Needle draft.',
            status: 'draft' as const,
            kind: 'article' as const,
          },
        ]
      : [],
  )
  expect(await searchLocalDocs({ query: 'needle' }, list as never)).toEqual([])
  expect(await searchLocalDocs({ query: 'needle', includeDrafts: true }, list as never)).toEqual([
    expect.objectContaining({ slug: 'draft-guide', status: 'draft' }),
  ])
})

test('local search hides matching working documents unless requested', async () => {
  const article = {
    id: 1,
    slug: 'article',
    title: 'Needle article',
    body: 'Article body.',
    status: 'current' as const,
    kind: 'article' as const,
  }
  const working = {
    ...article,
    id: 2,
    slug: 'working',
    title: 'Needle working document',
    kind: 'working' as const,
  }
  const list = mock(async () => [article, working])

  expect(await searchLocalDocs({ query: 'needle' }, list as never)).toEqual([
    expect.objectContaining({ slug: 'article' }),
  ])
  expect(await searchLocalDocs({ query: 'needle', includeWorking: true }, list as never)).toEqual([
    expect.objectContaining({ slug: 'article' }),
    expect.objectContaining({ slug: 'working' }),
  ])
})
