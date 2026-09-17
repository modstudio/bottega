import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedNotesPage } from '@/routes/notes'
import { HostedSettingsPage } from '@/routes/settings'
import { queryClient, trpc } from '@/trpc/client'

test('hosted notes and settings render their records without mutation controls', () => {
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
  queryClient.setQueryData(trpc.record.settings.queryOptions({ hours: 48 }).queryKey, {
    report: {
      enabled: true,
      to: ['reader@example.test'],
      fromName: 'Daily Work Report',
      fromAddress: 'sender@example.test',
      subjectPrefix: 'Daily Work Report',
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      smtpUser: 'sender',
      smtpPasswordRef: null,
      windowHours: 24,
      minMinutes: 15,
      projects: ['workshop'],
      briefs: [],
      testTo: '',
    },
    allProjects: ['workshop'],
    secrets: { smtpPassword: { configured: true, resolves: null } },
    sends: [
      {
        at: '2026-09-17T12:00:00.000Z',
        window: '24h',
        recipients: 'reader@example.test',
        projects: 'workshop',
        items: 2,
        status: 'sent',
        error: null,
        test: false,
      },
    ],
  })
  const notes = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <HostedNotesPage />
    </QueryClientProvider>,
  )
  const settings = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <HostedSettingsPage />
    </QueryClientProvider>,
  )
  expect(notes).toContain('Keep the boundary')
  expect(notes).toContain('session-1')
  expect(notes).not.toContain('Promote')
  expect(notes).not.toContain('Keep note')
  expect(settings).toContain('Reference stored; resolution unavailable on hosted server')
  expect(settings).toContain('reader@example.test')
  expect(settings).not.toContain('Save changes')
  expect(settings).not.toContain('Send a test')
  expect(settings).not.toContain('Refresh data')
})
