import { expect, test } from 'bun:test'
import { recordDocList } from './record-doc-list-shape.ts'

test('unwraps a JSON string containing a list and reports that decision', () => {
  expect(
    recordDocList('["src/article.ts"]', {
      document: 'doc-id',
      column: 'doc.source_files',
    }),
  ).toEqual({ values: ['src/article.ts'], unwrapped: true })
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
