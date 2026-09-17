import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedSettingsPage } from '@/routes/settings'
import { queryClient, trpc } from '@/trpc/client'

test('hosted settings report the reference without the secret or any control', () => {
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
  const settings = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <HostedSettingsPage />
    </QueryClientProvider>,
  )
  expect(settings).toContain('Reference stored; resolution unavailable on hosted server')
  expect(settings).toContain('reader@example.test')
  expect(settings).not.toContain('Save changes')
  expect(settings).not.toContain('Send a test')
  expect(settings).not.toContain('Refresh data')
})
