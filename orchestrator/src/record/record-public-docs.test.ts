import { describe, expect, test } from 'bun:test'
import { DOC_SNIPPET_START, DOC_SNIPPET_STOP } from '../../../shared/doc-snippet.ts'
import {
  normalizeDocSearchQuery,
  publicRecordDocRow,
  recordDocSearchMatchRow,
  searchPublicRecordDocs,
  searchRecordDocs,
} from './record-public-docs.ts'

describe('record public docs', () => {
  test('normalizes a search query', () => {
    expect(normalizeDocSearchQuery('  public\n\t document   search  ')).toBe(
      'public document search',
    )
    expect(normalizeDocSearchQuery(' \n ')).toBe('')
  })

  test('returns an empty search without opening a database connection', async () => {
    expect(
      await searchPublicRecordDocs({ url: 'postgres://invalid.invalid/record', query: ' \n ' }),
    ).toEqual([])
    expect(
      await searchRecordDocs({
        url: 'postgres://invalid.invalid/record',
        userId: 'user-a',
        spaceId: 'space-a',
        spaceIds: ['space-a'],
        query: '',
        acrossReadableSpaces: false,
      }),
    ).toEqual([])
  })

  test('maps public document and search rows', () => {
    expect(
      publicRecordDocRow({
        id: 'doc-a',
        slug: 'guide',
        title: 'Guide',
        body: 'Read me\n:::section{audience="internal"}\nSecret\n:::',
        parent_id: null,
        position: '2',
        updated_at: '2026-10-06T18:00:00Z',
        scope: 'global',
        subject: null,
        audiences: ['customer', 'technical'],
        kind: 'article',
      }),
    ).toEqual({
      id: 'doc-a',
      slug: 'guide',
      title: 'Guide',
      body: 'Read me\n',
      summary: 'Read me',
      featured: false,
      parentId: null,
      position: 2,
      updatedAt: '2026-10-06T18:00:00.000Z',
      scope: 'global',
      subject: null,
      audiences: ['technical', 'customer'],
      kind: 'article',
    })
    expect(
      recordDocSearchMatchRow({
        id: 'doc-a',
        slug: 'guide',
        title: 'Guide',
        status: 'current',
        kind: 'article',
        audiences: ['customer'],
        snippet: `${DOC_SNIPPET_START}Read${DOC_SNIPPET_STOP} me`,
        space_name: 'Public',
      }),
    ).toEqual({
      id: 'doc-a',
      slug: 'guide',
      title: 'Guide',
      status: 'current',
      kind: 'article',
      audiences: ['customer'],
      snippet: 'Read me',
      highlights: [{ start: 0, length: 4 }],
      spaceName: 'Public',
    })
  })
})
