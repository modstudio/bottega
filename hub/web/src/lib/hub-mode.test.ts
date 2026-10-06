import { expect, test } from 'bun:test'
import { isDocsPath, isHostedPath, isHostedSignInFramePath, navForMode } from './hub-mode.ts'

const destinations = (mode: 'hosted' | 'local') =>
  navForMode(mode).flatMap((section) =>
    section.entries.flatMap((entry) => ('items' in entry ? entry.items : [entry])),
  )

test('hosted mode exposes its hosted routes', () => {
  const hosted = destinations('hosted')
  expect(hosted.map((item) => item.to).sort()).toEqual(
    [
      '/agents',
      '/board',
      '/context',
      '/docs',
      '/done',
      '/flight',
      '/health',
      '/jobs',
      '/members',
      '/messages',
      '/notes',
      '/projects',
      '/ratio',
      '/reviews',
      '/reports',
      '/routing',
      '/runs',
      '/settings',
      '/spend',
    ].sort(),
  )
  for (const item of hosted) expect(isHostedPath(item.to)).toBe(true)
  expect(hosted.map((item) => item.label)).toContain('Flight')
  expect(destinations('local').map((item) => item.to)).toContain('/flight')
  expect(destinations('local').map((item) => item.to)).toContain('/context')
  expect(destinations('local').map((item) => item.to)).toContain('/messages')
  expect(hosted.map((item) => item.to)).toContain('/messages')
  expect(isHostedPath('/messages')).toBe(true)
  expect(isHostedPath('/messages/42')).toBe(true)
  expect(isHostedPath('/runs')).toBe(true)
  expect(isHostedPath('/runs/01990000-0000-7000-8000-000000000001')).toBe(true)
  expect(isHostedPath('/reviews')).toBe(true)
  expect(isHostedPath('/reports')).toBe(true)
  expect(isHostedPath('/sign-in')).toBe(true)
  expect(isHostedPath('/forgot-password')).toBe(true)
  expect(isHostedPath('/reset-password')).toBe(true)
  expect(isHostedPath('/projects')).toBe(true)
  expect(isHostedPath('/docs')).toBe(true)
  expect(isHostedPath('/docs/project/alpha/plan')).toBe(true)
  expect(isHostedPath('/jobs')).toBe(true)
  expect(isHostedPath('/agents')).toBe(true)
  expect(isHostedPath('/routing')).toBe(true)
  expect(isHostedPath('/health')).toBe(true)
  expect(isHostedPath('/flight')).toBe(true)
  expect(isHostedPath('/flight/tasks/DEV-701')).toBe(true)
  expect(isHostedPath('/board/tasks/DEV-701')).toBe(true)
  expect(isHostedPath('/done/tasks/DEV-701')).toBe(true)
  expect(isHostedPath('/settings')).toBe(true)
  expect(isHostedPath('/design')).toBe(false)
  expect(isHostedPath('/projects/alpha')).toBe(false)
})

test('hosted sign-in frame and docs paths stay reachable without the rail', () => {
  expect(isHostedSignInFramePath('/sign-in')).toBe(true)
  expect(isHostedSignInFramePath('/forgot-password')).toBe(true)
  expect(isHostedSignInFramePath('/reset-password')).toBe(true)
  expect(isHostedSignInFramePath('/accept-invitation/abc')).toBe(true)
  expect(isHostedSignInFramePath('/unsubscribe/space/token')).toBe(true)
  expect(isHostedSignInFramePath('/docs')).toBe(false)
  expect(isDocsPath('/docs')).toBe(true)
  expect(isDocsPath('/docs/project/bottega/first-run')).toBe(true)
  expect(isDocsPath('/runs')).toBe(false)
})

test('hosted member-management routes remain reachable and members appear in settings', () => {
  expect(isHostedPath('/members')).toBe(true)
  expect(isHostedPath('/accept-invitation/invitation-id')).toBe(true)
  const settings = navForMode('hosted')
    .flatMap((section) => section.entries)
    .find((entry) => 'items' in entry && entry.label === 'Settings')
  expect(settings && 'items' in settings ? settings.items.map((item) => item.to) : []).toContain(
    '/members',
  )
})
