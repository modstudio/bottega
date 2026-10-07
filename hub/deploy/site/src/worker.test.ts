import { expect, test } from 'bun:test'
import { appTarget } from './worker.ts'

test('the app target keeps the app origin whatever the path looks like', () => {
  for (const path of [
    '//evil.test/phish?x=1',
    '/docs/..//evil.test',
    '/\\evil.test',
    '/flight?tab=1',
  ]) {
    const target = appTarget(new URL(`https://public.example.test${path}`))
    expect(target.hostname.startsWith('app.')).toBe(true)
    expect(target.hostname.includes('evil')).toBe(false)
  }
  expect(appTarget(new URL('https://public.example.test/flight?tab=1')).search).toBe('?tab=1')
})
