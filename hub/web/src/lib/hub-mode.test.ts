import { expect, test } from 'bun:test'
import { isHostedPath, navForMode } from './hub-mode.ts'

test('hosted mode hides local routes', () => {
  const hosted = navForMode('hosted')
  expect(hosted.map((item) => item.to)).toEqual(['/runs', '/reviews', '/projects'])
  expect(hosted.map((item) => item.label)).not.toContain('Flight')
  expect(hosted.map((item) => item.label)).not.toContain('Settings')
  expect(navForMode('local').map((item) => item.to)).toContain('/flight')
  expect(isHostedPath('/runs')).toBe(true)
  expect(isHostedPath('/runs/01990000-0000-7000-8000-000000000001')).toBe(true)
  expect(isHostedPath('/reviews')).toBe(true)
  expect(isHostedPath('/sign-in')).toBe(true)
  expect(isHostedPath('/projects')).toBe(true)
  expect(isHostedPath('/flight')).toBe(false)
  expect(isHostedPath('/settings')).toBe(false)
  expect(isHostedPath('/projects/alpha')).toBe(false)
})
