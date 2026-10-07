import { describe, expect, test } from 'bun:test'
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
        body: 'Read me',
        parent_id: null,
        position: '2',
        updated_at: '2026-10-06T18:00:00Z',
        scope: 'global',
        subject: null,
      }),
    ).toEqual({
      id: 'doc-a',
      slug: 'guide',
      title: 'Guide',
      body: 'Read me',
      summary: 'Read me',
      featured: false,
      parentId: null,
      position: 2,
      updatedAt: '2026-10-06T18:00:00.000Z',
      scope: 'global',
      subject: null,
    })
    expect(
      recordDocSearchMatchRow({
        id: 'doc-a',
        slug: 'guide',
        title: 'Guide',
        snippet: '<b>Read</b> me',
        space_name: 'Public',
      }),
    ).toEqual({
      id: 'doc-a',
      slug: 'guide',
      title: 'Guide',
      snippet: '<b>Read</b> me',
      spaceName: 'Public',
    })
  })
})
