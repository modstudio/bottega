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
  expect(html).toContain('<td>Rules for files in the hub</td>')
  expect(html).toContain('<th>paths</th>')
  expect(html).toContain('<code>hub/**</code>')
  expect(html).toContain('<code>shared/**</code>')
  expect(html).not.toContain('<hr')
})
