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
        person_user_id: null,
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
  expect(settings).toContain('Remove')
  expect(settings.toLowerCase()).not.toContain('smtp')
  expect(settings).not.toContain('Send a test')
})

test('a subscription without recipients says that it is not due', () => {
  expect(renderSettings([])).toContain('No recipients; this subscription is not due.')
})
