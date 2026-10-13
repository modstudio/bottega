import { expect, mock, test } from 'bun:test'
import { recordDocList } from './record-doc-list-shape.ts'

test('unwraps and counts a JSON string containing a list', () => {
  const warn = mock(() => {})
  const originalWarn = console.warn
  console.warn = warn
  try {
    expect(
      recordDocList('["src/article.ts"]', {
        document: 'doc-id',
        column: 'doc.source_files',
      }),
    ).toEqual(['src/article.ts'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^unwrapped hosted document JSON string list #\d+: doc-id doc\.source_files$/,
      ),
    )
  } finally {
    console.warn = originalWarn
  }
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
