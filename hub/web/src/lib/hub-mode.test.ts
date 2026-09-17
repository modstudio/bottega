import { expect, test } from 'bun:test'
import { isHostedPath, navForMode } from './hub-mode.ts'

const destinations = (mode: 'hosted' | 'local') =>
  navForMode(mode).flatMap((section) =>
    section.entries.flatMap((entry) => ('items' in entry ? entry.items : [entry])),
  )

test('hosted mode hides local routes', () => {
  const hosted = destinations('hosted')
  expect(hosted.map((item) => item.to).sort()).toEqual(
    ['/agents', '/docs', '/health', '/jobs', '/projects', '/reviews', '/routing', '/runs'].sort(),
  )
  for (const item of hosted) expect(isHostedPath(item.to)).toBe(true)
  expect(hosted.map((item) => item.label)).not.toContain('Flight')
  expect(destinations('local').map((item) => item.to)).toContain('/flight')
  expect(isHostedPath('/runs')).toBe(true)
  expect(isHostedPath('/runs/01990000-0000-7000-8000-000000000001')).toBe(true)
  expect(isHostedPath('/reviews')).toBe(true)
  expect(isHostedPath('/sign-in')).toBe(true)
  expect(isHostedPath('/projects')).toBe(true)
  expect(isHostedPath('/docs')).toBe(true)
  expect(isHostedPath('/docs/project/alpha/plan')).toBe(true)
  expect(isHostedPath('/jobs')).toBe(true)
  expect(isHostedPath('/agents')).toBe(true)
  expect(isHostedPath('/routing')).toBe(true)
  expect(isHostedPath('/health')).toBe(true)
  expect(isHostedPath('/flight')).toBe(false)
  expect(isHostedPath('/settings')).toBe(false)
  expect(isHostedPath('/projects/alpha')).toBe(false)
})
