import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { DocsFacts } from './facts.tsx'
import type { DocsDoc, DocsSource } from './types.ts'

const doc: DocsDoc = {
  id: 'doc-1',
  slug: 'working-agreement',
  title: 'Working agreement',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-12T12:00:00.000Z',
  scope: 'project',
  subject: 'workshop',
  audiences: ['internal'],
  status: 'current',
  replacementSlug: null,
  body: 'Write down what matters.',
}

function renderFacts(signedIn: boolean, source: DocsSource) {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DocsFacts doc={doc} headings={[]} signedIn={signedIn} source={source} />
    </QueryClientProvider>,
  )
}

test('history is available only to signed-in readers of local docs', () => {
  expect(renderFacts(true, 'local')).toContain('History')
  expect(renderFacts(false, 'local')).not.toContain('History')
  expect(renderFacts(true, 'hosted')).not.toContain('History')
})
