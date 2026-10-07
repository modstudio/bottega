import { expect, test } from 'bun:test'
import {
  hostedOrigin,
  isDocsPath,
  isHostedPath,
  isHostedSignInFramePath,
  isMarketingPath,
  navForMode,
  sameLocationOn,
  unauthorizedLeadsToSignIn,
} from './hub-mode.ts'

test('hosted origin is public, app, or unconfigured', () => {
  const configured = {
    publicOrigin: 'https://public.example.test/',
    appOrigin: 'https://app.example.test/',
  }
  expect(hostedOrigin('https://public.example.test', configured)).toEqual({
    kind: 'public',
    publicOrigin: 'https://public.example.test',
    appOrigin: 'https://app.example.test',
  })
  expect(hostedOrigin('https://app.example.test', configured)).toEqual({
    kind: 'app',
    publicOrigin: 'https://public.example.test',
    appOrigin: 'https://app.example.test',
  })
  expect(hostedOrigin('http://localhost:5173', configured).kind).toBe('app')
  expect(hostedOrigin('https://public.example.test', { ...configured, publicOrigin: '' })).toEqual({
    kind: 'unconfigured',
  })
  expect(hostedOrigin('https://public.example.test', { ...configured, appOrigin: '' })).toEqual({
    kind: 'unconfigured',
  })
})

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
  expect(isDocsPath('/docs/project/atlas/first-run')).toBe(true)
  expect(isDocsPath('/runs')).toBe(false)
})

test('marketing paths are hosted-only public destinations', () => {
  expect(isMarketingPath('/')).toBe(true)
  expect(isMarketingPath('/product/orchestration')).toBe(true)
  expect(isMarketingPath('/product/board/')).toBe(true)
  expect(isMarketingPath('/products')).toBe(false)
  expect(isHostedPath('/')).toBe(true)
  expect(isHostedPath('/product/workers')).toBe(true)
  expect(
    navForMode('local').some((section) =>
      section.entries.some((entry) => 'to' in entry && entry.to.startsWith('/product/')),
    ),
  ).toBe(false)
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

test('a move to another origin stays on that origin whatever the path looks like', () => {
  const app = 'https://app.example.test'
  for (const pathname of ['//evil.test/phish', '///evil.test', '/\\evil.test', '/flight']) {
    const href = sameLocationOn(app, { pathname, search: '?x=1', hash: '#frag' })
    expect(new URL(href).origin).toBe(app)
    expect(href.endsWith('?x=1#frag')).toBe(true)
  }
})

test('an unauthorised answer leads to sign-in only from the signed-in app', () => {
  for (const path of ['/', '/product/board', '/docs', '/docs/project/x/y', '/sign-in']) {
    expect(unauthorizedLeadsToSignIn(path, 'app')).toBe(false)
    expect(unauthorizedLeadsToSignIn(path, 'unconfigured')).toBe(false)
  }
  expect(unauthorizedLeadsToSignIn('/flight', 'app')).toBe(true)
  expect(unauthorizedLeadsToSignIn('/flight', 'unconfigured')).toBe(true)
  expect(unauthorizedLeadsToSignIn('/flight', 'public')).toBe(false)
})
