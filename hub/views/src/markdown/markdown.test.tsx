import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { secondLevelHeadings } from './headings.ts'
import { Markdown } from './markdown.tsx'

const render = (content: string) => renderToStaticMarkup(<Markdown content={content} />)
const key = (name: string) => new RegExp(`<dt[^>]*>${name}</dt>`)
const detail = (text: string) => new RegExp(`<dd[^>]*>${text}</dd>`)

test('renders canon frontmatter with paths as document properties', () => {
  const html = render(`---
description: Rules for files in the hub
paths:
  - hub/**
  - shared/**
---

## Rule

Keep concerns separate.`)

  expect(html).toMatch(key('description'))
  expect(html).toContain('>Rules for files in the hub</span>')
  expect(html).toMatch(key('paths'))
  expect(html).toContain('>hub/**</span>')
  expect(html).toContain('>shared/**</span>')
  expect(html).toContain('<h2 id="rule">Rule</h2>')
  expect(html).not.toContain('<hr')
})

test('renders canon always frontmatter with a readable boolean', () => {
  const html = render(`---
description: Rules that always apply
always: true
---

## Rule`)

  expect(html).toMatch(key('always'))
  expect(html).toMatch(detail('yes'))
  expect(html).toContain('<h2 id="rule">Rule</h2>')
})

test('renders a resume brief with flat scalar properties and preserves its timestamp', () => {
  const html = render(`---
status: paused
epic: DEV-1400
project: workshop
written: 2026-10-20T14:05:06Z
consumed: false
consumed_by: worker-7
updated: 2026-10-20
---

Resume here.`)

  expect(html).toMatch(key('status'))
  expect(html).toContain('>paused</span>')
  expect(html).toContain('>2026-10-20T14:05:06Z</span>')
  expect(html).toMatch(key('consumed'))
  expect(html).toMatch(detail('no'))
  expect(html).toContain('<p>Resume here.</p>')
})

test('renders a ruling record and keeps multiline strings as one property value', () => {
  const html = render(`---
question_id: question-12
run: run-9
task: DEV-1440
date: 2026-10-20
answerer: architect
question: |-
  Should the document body
  retain its line numbers?
ruling: |-
  Yes. Frontmatter must not
  shift heading ids.
---

## Result`)

  expect(html).toContain('Should the document body\nretain its line numbers?')
  expect(html).toContain('Yes. Frontmatter must not\nshift heading ids.')
  expect(html).toContain('<h2 id="result">Result</h2>')
})

test('renders nested frontmatter maps as an indented property list', () => {
  const html = render(`---
owner:
  name: Hub
  active: true
---`)

  expect(html).toMatch(key('owner'))
  expect(html.match(/<dl /g)).toHaveLength(2)
  expect(html).toMatch(key('name'))
  expect(html).toMatch(key('active'))
  expect(html).toMatch(detail('yes'))
})

test('renders maps and lists inside frontmatter lists structurally', () => {
  const html = render(`---
values:
  - nested: value
  - [one, two]
---`)

  expect(html).toMatch(key('values'))
  expect(html).toMatch(key('nested'))
  expect(html).toContain('>value</span>')
  expect(html).toContain('>one</span>')
  expect(html).toContain('>two</span>')
  expect(html).not.toContain('[object Object]')
  expect(html).not.toContain('one,two')
})

test('shows unparseable frontmatter verbatim instead of rendering it as markdown', () => {
  const html = render(`---
description: [not closed
---

Body`)

  expect(html).toContain('Frontmatter could not be read.')
  expect(html).toContain('<code>---\ndescription: [not closed\n---</code>')
  expect(html).toContain('<p>Body</p>')
  expect(html).not.toContain('<hr')
})

test('renders a document without frontmatter unchanged', () => {
  const html = render('# Plain document\n\nA paragraph with **weight**.')

  expect(html).toBe(
    '<div class="markdown"><h1>Plain document</h1>\n<p>A paragraph with <strong>weight</strong>.</p></div>',
  )
})

test('keeps a thematic break later in the document', () => {
  const html = render('# Document\n\nBefore\n\n---\n\nAfter')

  expect(html).toContain('<p>Before</p>\n<hr/>\n<p>After</p>')
})

test('frontmatter headings stay out of contents without shifting rendered heading ids', () => {
  const content = `---
description: |-
  Notes may include markdown-looking lines.
  ## Same
---

## Same

## Next`
  const contents = secondLevelHeadings(content)
  const html = render(content)
  const renderedIds = [...html.matchAll(/<h2 id="([^"]+)">/g)].map((match) => match[1])

  expect(contents).toEqual([
    { id: 'same', title: 'Same' },
    { id: 'next', title: 'Next' },
  ])
  expect(renderedIds).toEqual(contents.map(({ id }) => id))
})
