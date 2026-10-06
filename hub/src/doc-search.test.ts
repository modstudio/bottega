import { describe, expect, mock, test } from 'bun:test'
import { docSnippet, searchLocalDocs } from './doc-search.ts'

describe('docSnippet', () => {
  test('places a middle match inside a bounded window', () => {
    const result = docSnippet(`${'a'.repeat(100)}Needle${'b'.repeat(100)}`, 'Title', 'needle')
    expect(result.snippet).toBe(`${'a'.repeat(60)}Needle${'b'.repeat(60)}`)
    expect(result.matchPosition).toBe(60)
  })

  test('keeps matches at the start and end', () => {
    expect(docSnippet(`Needle${'b'.repeat(100)}`, 'Title', 'needle')).toEqual({
      snippet: `Needle${'b'.repeat(60)}`,
      matchPosition: 0,
    })
    const end = docSnippet(`${'a'.repeat(100)}Needle`, 'Title', 'needle')
    expect(end).toEqual({ snippet: `${'a'.repeat(60)}Needle`, matchPosition: 60 })
  })

  test('uses the start of the body for title-only and absent matches', () => {
    const body = 'Body without the term.'
    expect(docSnippet(body, 'Needle title', 'needle')).toEqual({
      snippet: body,
      matchPosition: null,
    })
    expect(docSnippet(body, 'Other title', 'needle')).toEqual({
      snippet: body,
      matchPosition: null,
    })
  })

  test('does not split multi-byte code points and reports a usable string position', () => {
    const result = docSnippet(`${'😀'.repeat(70)}NÉÉDLE`, 'Title', 'néédle')
    expect(result.snippet.startsWith('😀')).toBe(true)
    expect(result.matchPosition).toBe(120)
    expect(result.snippet.slice(result.matchPosition!)).toStartWith('NÉÉDLE')
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
    audience: 'technical' as const,
    parent_id: null,
    parent_slug: null,
    position: 0,
    revision: null,
    created_at: '2026-10-06T12:00:00.000Z',
    updated_at: '2026-10-06T12:00:00.000Z',
  }
  const list = mock(async () => [base, { ...base, id: 2, body: 'Other.', subject: 'needle' }])
  expect(await searchLocalDocs({ query: 'needle' }, list as never)).toEqual([
    {
      id: '1',
      slug: 'guide',
      title: 'Guide',
      snippet: 'A needle in the body.',
      matchPosition: 2,
    },
  ])
  expect(list).toHaveBeenCalledTimes(1)
  expect(list).toHaveBeenCalledWith({
    scope: undefined,
    subject: undefined,
    audience: undefined,
    match: 'needle',
    bodyMatch: 'needle',
  })
})
