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
        recipient_user_id: '01990000-0000-7000-8000-000000000701',
        recipient_name: 'Reader',
        recipient_email: 'reader@example.test',
        enabled: true,
        created_at: '2026-09-18T12:00:00.000Z',
        updated_at: '2026-09-18T12:00:00.000Z',
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

test('hosted settings render subscriptions and offer no control to change them', () => {
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
    sends: [],
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
        recipient_user_id: '01990000-0000-7000-8000-000000000701',
        recipient_name: 'Reader',
        recipient_email: 'reader@example.test',
        enabled: true,
        created_at: '2026-09-18T12:00:00.000Z',
        updated_at: '2026-09-18T12:00:00.000Z',
      },
    ],
  })
  const settings = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <HostedSettingsPage />
    </QueryClientProvider>,
  )
  expect(settings).toContain('Subscriptions')
  expect(settings).toContain('project workshop')
  expect(settings).toContain('weekly monday 8:00 America/New_York')
  expect(settings).toContain('reader@example.test')
  expect(settings).toContain('enabled')
  expect(settings).not.toContain('Subscribe')
  expect(settings).not.toContain('Unsubscribe')
  expect(settings).not.toContain('<button')
  expect(settings).not.toContain('<input')
  expect(settings).not.toContain('<select')
  expect(settings).not.toContain('<form')
})
