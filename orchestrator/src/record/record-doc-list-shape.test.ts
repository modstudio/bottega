import { expect, test } from 'bun:test'
import { recordDocList, recordDocUnwrappedStringListCount } from './record-doc-list-shape.ts'

test('unwraps and counts a JSON string containing a list', () => {
  const before = recordDocUnwrappedStringListCount()
  expect(
    recordDocList('["src/article.ts"]', {
      document: 'doc-id',
      column: 'doc.source_files',
    }),
  ).toEqual(['src/article.ts'])
  expect(recordDocUnwrappedStringListCount()).toBe(before + 1)
})

test.each(['not json', '{"file":"src/article.ts"}', 7])(
  'refuses the wrong hosted list shape %#',
  (value) => {
    expect(() =>
      recordDocList(value, {
        document: 'doc-id',
        column: 'doc.source_files',
      }),
    ).toThrow(/doc-id.*doc\.source_files/)
  },
)
