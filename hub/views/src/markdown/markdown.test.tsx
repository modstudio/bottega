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
