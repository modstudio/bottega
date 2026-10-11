import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './markdown.tsx'

test('marked sections render their existing audience labels without fence text', () => {
  const html = renderToStaticMarkup(
    <Markdown
      content={':::section{audience="technical,customer"}\n## Stored margin\n\nBody.\n:::'}
    />,
  )
  expect(html).toContain('Technical, Customer')
  expect(html).toContain('Stored margin')
  expect(html).toContain('Body.')
  expect(html).not.toContain(':::section')
})
