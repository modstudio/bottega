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
    snippet: 'alt text left · right const value = 1 Keep & entities',
    highlights: [{ start: 'alt text left · right const '.length, length: 'value'.length }],
  })
})

test('html tags become spaces, entities decode, and a literal angle stays', () => {
  const marked = `| foo<br>bar | ${start}margin${stop}&amp; | a < b`
  const snippet = 'foo bar · margin& · a < b'
  expect(docPlainSnippet(marked)).toEqual({
    snippet,
    highlights: [{ start: snippet.indexOf('margin'), length: 'margin'.length }],
  })
})

test('consecutive table rows separate with a slash and keep a space next to prose', () => {
  expect(docPlainSnippet('| stock remains |\n| $100 | $80 |')).toEqual({
    snippet: 'stock remains / $100 · $80',
    highlights: [],
  })
  expect(
    docPlainSnippet(['Prose', '| stock remains |', '| $100 | $80 |', 'after'].join('\n')),
  ).toEqual({
    snippet: 'Prose stock remains / $100 · $80 after',
    highlights: [],
  })
})

test('underscore emphasis leaves intraword underscores and still strips wrapping markers', () => {
  expect(docPlainSnippet('stock_stated_at and _copy_ and __strong__ and foo*bar*baz')).toEqual({
    snippet: 'stock_stated_at and copy and strong and foobarbaz',
    highlights: [],
  })
})
