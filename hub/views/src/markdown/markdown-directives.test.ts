import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './markdown.tsx'

const render = (content: string) => renderToStaticMarkup(createElement(Markdown, { content }))

test('prose that looks like an inline directive keeps its text', () => {
  const html = render(
    'Quarantined at 16:41, then :note[read this]{tone="info"} and a ratio of 3:2.',
  )
  expect(html).toContain('16:41')
  expect(html).toContain(':note[read this]{tone=&quot;info&quot;}')
  expect(html).toContain('3:2')
  expect(html).not.toContain('<div></div>')
})

test('a line that looks like a leaf directive keeps its text', () => {
  expect(render('::42')).toContain('::42')
})

test('a section container still marks its audiences', () => {
  const html = render(':::section{audience="technical, operator"}\nBody\n:::')
  expect(html).toContain('Technical, Operator')
  expect(html).toContain('Body')
})
