import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedNotesPage } from '@/routes/notes'
import { queryClient, trpc } from '@/trpc/client'

test('hosted notes render their records without disposition controls', () => {
  queryClient.setQueryData(trpc.record.notes.queryOptions({ stale: false }).queryKey, {
    notes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        number: 7,
        label: 'workshop#7',
        space_id: '00000000-0000-4000-8000-000000000001',
        space_name: 'Workshop',
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
        space_id: '00000000-0000-4000-8000-000000000001',
        note_id: '11111111-1111-4111-8111-111111111111',
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
  expect(notes).toContain('Workshop')
  expect(notes).toContain('session-1')
  expect(notes).not.toContain('Promote')
  expect(notes).not.toContain('Keep note')
})
