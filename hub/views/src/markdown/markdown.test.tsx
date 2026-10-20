import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './markdown.tsx'

const render = (content: string) => renderToStaticMarkup(<Markdown content={content} />)

test('renders canon frontmatter with paths as document properties', () => {
  const html = render(`---
description: Rules for files in the hub
paths:
  - hub/**
  - shared/**
---

## Rule

Keep concerns separate.`)

  expect(html).toContain('<th>description</th>')
  expect(html).toContain('>Rules for files in the hub</span>')
  expect(html).toContain('<th>paths</th>')
  expect(html).toContain('<code>hub/**</code>')
  expect(html).toContain('<code>shared/**</code>')
  expect(html).toContain('<h2 id="rule">Rule</h2>')
  expect(html).not.toContain('<hr')
})

test('renders canon always frontmatter with a readable boolean', () => {
  const html = render(`---
description: Rules that always apply
always: true
---

## Rule`)

  expect(html).toContain('<th>always</th>')
  expect(html).toContain('<td>yes</td>')
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

  expect(html).toContain('<th>status</th>')
  expect(html).toContain('>paused</span>')
  expect(html).toContain('>2026-10-20T14:05:06Z</span>')
  expect(html).toContain('<th>consumed</th><td>no</td>')
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

  expect(html).toContain('<th>owner</th>')
  expect(html).toContain('class="ml-3" data-fit=""')
  expect(html).toContain('<th>name</th>')
  expect(html).toContain('<th>active</th><td>yes</td>')
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
