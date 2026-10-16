import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DocsSource } from '@bottega/hub-data/docs/use-docs'
import { renderToStaticMarkup } from 'react-dom/server'
import { DocsFacts } from './facts.tsx'
import type { DocsDoc } from './types.ts'

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
  kind: 'article',
  summarySource: 'derived',
  replacementSlug: null,
  body: 'Write down what matters.',
}

function renderFacts(signedIn: boolean, source: DocsSource) {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DocsFacts
        doc={doc}
        headings={[]}
        signedIn={signedIn}
        showHistory={source !== 'public'}
        history={{ items: [], pending: false, error: null }}
      />
    </QueryClientProvider>,
  )
}

test('history is available only to signed-in readers of private docs', () => {
  expect(renderFacts(true, 'local')).toContain('History')
  expect(renderFacts(false, 'local')).not.toContain('History')
  expect(renderFacts(true, 'hosted')).toContain('History')
  expect(renderFacts(false, 'hosted')).not.toContain('History')
})
