import { expect, test } from 'bun:test'
import { highlightSnippet } from './map.ts'

test('search highlight wraps each range', () => {
  expect(
    highlightSnippet({
      snippet: 'the worktree is disposable',
      highlights: [{ start: 4, length: 8 }],
    }),
  ).toEqual([
    { text: 'the ', highlight: false, start: 0 },
    { text: 'worktree', highlight: true, start: 4 },
    { text: ' is disposable', highlight: false, start: 12 },
  ])
  expect(highlightSnippet({ snippet: 'plain text', highlights: [] })).toEqual([
    { text: 'plain text', highlight: false, start: 0 },
  ])
})
