import { expect, test } from 'bun:test'
import { DOC_SNIPPET_START, DOC_SNIPPET_STOP, docPlainSnippet } from './doc-snippet.ts'

const start = DOC_SNIPPET_START
const stop = DOC_SNIPPET_STOP

test('a table row fragment with two highlights matches the operator case', () => {
  const marked = `| ${start}Margin${stop} is 20%, but stock remains | | $100 | $80 | 0 | Removed | No stock and ${start}margin${stop} below`
  const snippet =
    'Margin is 20%, but stock remains · $100 · $80 · 0 · Removed · No stock and margin below'
  expect(docPlainSnippet(marked)).toEqual({
    snippet,
    highlights: [
      { start: snippet.indexOf('Margin'), length: 'Margin'.length },
      { start: snippet.indexOf('margin'), length: 'margin'.length },
    ],
  })
})

test('links, emphasis, and headings become readable text', () => {
  const marked = `# ${start}See${stop} the [guide](https://example.com) and **bold** _copy_`
  expect(docPlainSnippet(marked)).toEqual({
    snippet: 'See the guide and bold copy',
    highlights: [{ start: 0, length: 3 }],
  })
})

test('images, lists, quotes, fences, separator rows, and entities follow the snippet rules', () => {
  const marked = [
    '> - ![alt text](https://example.com/a.png)',
    '| --- | --- |',
    '| left | | right |',
    '```ts',
    `const ${start}value${stop} = 1`,
    '```',
    'Keep &amp; entities',
  ].join('\n')
  expect(docPlainSnippet(marked)).toEqual({
    snippet: 'alt text left · right const value = 1 Keep &amp; entities',
    highlights: [{ start: 'alt text left · right const '.length, length: 'value'.length }],
  })
})
