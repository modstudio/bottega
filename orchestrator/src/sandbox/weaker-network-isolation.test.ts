import { expect, test } from 'bun:test'
import { decideWeakerNetworkIsolation } from './weaker-network-isolation.ts'

test('a remote HTTPS agent endpoint enables weaker network isolation and names why', () => {
  expect(decideWeakerNetworkIsolation({ base_url: 'https://openrouter.ai/api/v1' })).toEqual({
    enabled: true,
    reason:
      'weaker network isolation enabled: remote HTTPS endpoint openrouter.ai ' +
      'requires macOS trustd for TLS verification',
  })
})

test('missing, invalid, non-HTTPS, and loopback endpoints keep weaker isolation off', () => {
  const off = { enabled: false, reason: null }
  expect(decideWeakerNetworkIsolation({})).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: null })).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: 'not a url' })).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: 'http://openrouter.ai/api/v1' })).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: 'https://127.0.0.1:8000/v1' })).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: 'https://127.0.0.2/v1' })).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: 'https://localhost/v1' })).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: 'https://[::1]/v1' })).toEqual(off)
  expect(decideWeakerNetworkIsolation({ base_url: 'https://[::ffff:127.0.0.1]/v1' })).toEqual(off)
})
