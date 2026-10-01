import { describe, expect, test } from 'bun:test'
import type { DocRow } from '../corpus/chunks.ts'
import { checkDocPins } from './doc-pins.ts'
import type { DocBenchmarkQuery } from './queries.ts'

const pin = (excerpt: string): DocBenchmarkQuery => ({
  id: 'query-one',
  query: 'Where is the answer?',
  scope: 'project',
  goldLabels: ['doc:project/sample/guide'],
  provenance: { doc: 'doc:project/sample/guide', excerpt },
})

const doc = (body: string): DocRow => ({
  scope: 'project',
  subject: 'sample',
  slug: 'guide',
  title: 'Guide',
  body,
  revision: 'revision-7',
})

describe('document benchmark pin decision', () => {
  test('accepts whitespace-only differences and reports the current revision', () => {
    expect(
      checkDocPins([pin('the pinned\nanswer')], [doc('Before the   pinned answer after')]),
    ).toEqual([
      {
        queryId: 'query-one',
        doc: 'doc:project/sample/guide',
        docSlug: 'guide',
        excerpt: 'the pinned\nanswer',
        revision: 'revision-7',
        current: true,
      },
    ])
  })

  test('does not ignore case or markdown changes', () => {
    expect(checkDocPins([pin('The `pinned` answer')], [doc('The pinned answer')])[0]?.current).toBe(
      false,
    )
  })

  test('reports a missing document as stale', () => {
    expect(checkDocPins([pin('answer')], [])).toEqual([
      {
        queryId: 'query-one',
        doc: 'doc:project/sample/guide',
        docSlug: 'guide',
        excerpt: 'answer',
        revision: null,
        current: false,
      },
    ])
  })
})
