import { expect, test } from 'bun:test'
import {
  HOSTED_FREE_TEXT_WRITE_ROUTES,
  HOSTED_WRITE_SECRET_LEAVES,
  maskHostedWrite,
} from './hosted-secret-mask.ts'
import { redactSecretShaped } from './secret-shaped.ts'

test('hosted mask redacts high-precision leaves and preserves generic prose byte-identically', () => {
  const token = 'ghp_123456789012345678901234567890123456'
  const generic = 'a key=value line with bearer prose and VGhpcyBpcyBhIGdlbmVyaWMgcHJvc2Ugc2FtcGxl'
  const input = { title: `quoted ${token}`, body: generic, untouched: token }
  const masked = maskHostedWrite('hub.task.create', input)
  expect(masked).toEqual({
    title: redactSecretShaped(`quoted ${token}`, { precision: 'high' }).text,
    body: generic,
    untouched: token,
  })
  expect(input.title).toBe(`quoted ${token}`)
})

test('every hosted free-text write route has a non-empty leaf declaration', () => {
  const identities = new Set<string>()
  for (const route of HOSTED_FREE_TEXT_WRITE_ROUTES) {
    expect(HOSTED_WRITE_SECRET_LEAVES[route.declaration].length, route.path).toBeGreaterThan(0)
    const identity = `${route.method} ${route.path}`
    expect(identities.has(identity), identity).toBe(false)
    identities.add(identity)
  }
})
