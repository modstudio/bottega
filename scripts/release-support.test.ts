import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../shared/brand.ts'
import { distributionManifest, releaseVersion } from './release-support.ts'

test('the release manifest has the distribution shape', () => {
  expect(distributionManifest('1.2.3', '2026-09-18T12:00:00Z', 'abc123')).toEqual({
    name: PLATFORM_NAME,
    version: '1.2.3',
    built: '2026-09-18T12:00:00Z',
    commit: 'abc123',
  })
})

test('the release version comes from a v tag', () => {
  expect(releaseVersion('v1.2.3')).toBe('1.2.3')
  expect(() => releaseVersion('1.2.3')).toThrow('release tag must match v*')
  expect(() => releaseVersion('v../escape')).toThrow('release tag must match v*')
})
