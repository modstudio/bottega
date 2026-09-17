import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedDocContent } from './hosted-doc-detail'

test('hosted document content renders read-only without mutation controls', () => {
  const html = renderToStaticMarkup(
    <HostedDocContent
      doc={{ body: '# Hosted document' }}
      revisions={[
        {
          id: 'revision-a',
          op: 'set',
          author: 'operator',
          reason: 'updated',
          at: '2026-09-17T12:00:00.000Z',
        },
      ]}
    />,
  )
  expect(html).toContain('Hosted document')
  expect(html).toContain('History')
  expect(html).not.toContain('>Edit<')
  expect(html).not.toContain('>Delete<')
  expect(html).not.toContain('>Restore<')
})
