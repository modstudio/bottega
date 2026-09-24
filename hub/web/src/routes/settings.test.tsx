import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPage } from '@/routes/settings'
import { queryClient, trpc } from '@/trpc/client'

const member = {
  user_id: '01990000-0000-7000-8000-000000000701',
  name: 'Reader',
  email: 'reader@example.test',
}

function renderSettings(recipients = [member]) {
  queryClient.setQueryData(trpc.record.settings.queryOptions({ hours: 48 }).queryKey, {
    allProjects: ['workshop'],
    callerRole: 'owner',
    members: [member],
    sends: [
      {
        at: '2026-09-17T12:00:00.000Z',
        window: '24h',
        recipients: 'reader@example.test',
        recipient_details: [member],
        projects: 'subscription',
        items: 2,
        status: 'sent',
        error: null,
        test: false,
      },
    ],
    subscriptions: [
      {
        id: '01990000-0000-7000-8000-000000000768',
        scope_kind: 'project' as const,
        project_name: 'workshop',
        members: [],
        cadence: 'weekly' as const,
        hour: 8,
        weekday: 'monday' as const,
        zone: 'America/New_York',
        recipients: recipients.map((recipient, index) => ({
          ...recipient,
          id: `01990000-0000-7000-8000-00000000070${index + 2}`,
        })),
        enabled: true,
        created_at: '2026-09-18T12:00:00.000Z',
        updated_at: '2026-09-18T12:00:00.000Z',
      },
    ],
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  )
}

test('settings render subscriptions and send history without retired SMTP controls', () => {
  const settings = renderSettings()
  expect(settings).toContain('Report subscriptions')
  expect(settings).toContain('Send history')
  expect(settings).toContain('reader@example.test')
  expect(settings).toContain('Create subscription')
  expect(settings).toContain('Edit')
  expect(settings.toLowerCase()).not.toContain('smtp')
  expect(settings).not.toContain('Confirm delete')
})

test('a subscription without recipients keeps the recipient cell read-only', () => {
  const settings = renderSettings([])
  expect(settings).toContain('Recipients')
  expect(settings).not.toContain('Add member')
})
