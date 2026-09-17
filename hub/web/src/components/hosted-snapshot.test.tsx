import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SnapshotEmpty } from './hosted-snapshot'

test('a missing snapshot renders its empty state without an error', () => {
  const html = renderToStaticMarkup(<SnapshotEmpty title="Agents" />)
  expect(html).toContain('No agents snapshot is available.')
  expect(html).not.toContain('data-tone="error"')
})
