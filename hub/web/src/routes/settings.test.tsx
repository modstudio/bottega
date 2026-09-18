import { expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { nextReportArrival } from '@/lib/report-arrival'
import { HostedSettingsPage, Route } from '@/routes/settings'
import { queryClient, trpc } from '@/trpc/client'

test('hosted settings keep stored report values read only', () => {
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

test('hosted settings render subscription controls and the next arrival', () => {
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
  expect(settings).toContain('Create subscription')
  expect(settings).toContain('Edit')
  expect(settings).toContain('Remove')
  expect(settings).toContain('Next arrival:')
  expect(settings).toContain('(America/New_York).')
  expect(settings).toContain('<button')
  expect(settings).toContain('<input')
  expect(settings).not.toContain('<select')
})

test('next arrival follows the chosen hour and zone', () => {
  const next = nextReportArrival(
    {
      cadence: 'weekly',
      hour: 18,
      weekday: 'monday',
      zone: 'America/New_York',
    },
    new Date('2026-09-18T12:00:00.000Z'),
  )
  expect(next).toBe('Next arrival: Monday, September 21 at 6:00 PM EDT (America/New_York).')
})

test('local mode still renders the local settings page', () => {
  const SettingsComponent = Route.options.component
  expect(SettingsComponent).toBeDefined()
  if (!SettingsComponent) throw new Error('settings route component is absent')
  const settings = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SettingsComponent />
    </QueryClientProvider>,
  )
  expect(settings).toContain('Daily report')
  expect(settings).toContain('Loading settings')
  expect(settings).not.toContain('Create subscription')
})
