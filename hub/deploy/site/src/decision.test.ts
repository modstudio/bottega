import { expect, test } from 'bun:test'
import { decideSiteRequest } from './decision.ts'

test('forwards the marketing and docs routes', () => {
  for (const path of ['/', '/product/board', '/docs', '/docs/canon/global/principles']) {
    expect(decideSiteRequest('GET', path)).toBe('forward')
    expect(decideSiteRequest('HEAD', path)).toBe('forward')
  }
})

test('forwards build assets and root static files', () => {
  expect(decideSiteRequest('GET', '/assets/index-D4Rk.js')).toBe('forward')
  expect(decideSiteRequest('GET', '/favicon.svg')).toBe('forward')
  expect(decideSiteRequest('GET', '/robots.txt')).toBe('forward')
})

test('forwards only publicDocs tRPC procedures, including batches', () => {
  expect(decideSiteRequest('GET', '/trpc/publicDocs.tree')).toBe('forward')
  expect(decideSiteRequest('GET', '/trpc/publicDocs.tree,publicDocs.get,publicDocs.search')).toBe(
    'forward',
  )
  expect(decideSiteRequest('GET', '/trpc/publicDocs.tree%2CpublicDocs.get')).toBe('forward')
  expect(decideSiteRequest('GET', '/trpc/record.whoami')).toBe('redirect')
  expect(decideSiteRequest('GET', '/trpc/publicDocs.tree,record.whoami')).toBe('redirect')
})

test('redirects app paths and refuses methods other than GET and HEAD', () => {
  expect(decideSiteRequest('GET', '/flight?ignored-by-path-decision=true')).toBe('redirect')
  expect(decideSiteRequest('POST', '/docs')).toBe('refuse')
  expect(decideSiteRequest('OPTIONS', '/trpc/publicDocs.tree')).toBe('refuse')
})
