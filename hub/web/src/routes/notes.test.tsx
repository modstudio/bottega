import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedNotesPage } from '@/routes/notes'
import { queryClient, trpc } from '@/trpc/client'

test('hosted notes render their records without disposition controls', () => {
  queryClient.setQueryData(trpc.record.notes.queryOptions({ stale: false }).queryKey, {
    notes: [
      {
        id: 7,
        project: 'workshop',
        text: 'Keep the boundary',
        area: 'hub',
        anchors: [],
        sightings: 2,
        created_at: '2026-09-17T10:00:00.000Z',
        last_seen_at: '2026-09-17T11:00:00.000Z',
        stale_at: null,
        stale_reason: null,
        promoted_task: null,
      },
    ],
    acknowledgements: [
      {
        note_id: 7,
        session_id: 'session-1',
        acknowledged_at: '2026-09-17T11:30:00.000Z',
        sightings: 2,
      },
    ],
  })
  const notes = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <HostedNotesPage />
    </QueryClientProvider>,
  )
  expect(notes).toContain('Keep the boundary')
  expect(notes).toContain('session-1')
  expect(notes).not.toContain('Promote')
  expect(notes).not.toContain('Keep note')
})
