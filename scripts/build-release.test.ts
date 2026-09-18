import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../shared/brand.ts'
import { DIST_MANIFEST } from '../shared/install-root.ts'
import { DECLARED_PAYLOAD_PATHS, distributionManifest, releaseVersion } from './build-release.ts'

test('the payload has only the declared runtime paths', () => {
  expect(DECLARED_PAYLOAD_PATHS).toEqual([
    'orchestrator/src/cli/orch.ts',
    'hub/src/cli.ts',
    'orchestrator/src/run/exec.ts',
    'orchestrator/migrations',
    'hub/migrations',
    'orchestrator/hooks',
    'hub/web/dist',
    'ops/install.sh',
    'ops/bin',
    'ops/launchd',
    'hub/bin',
    'hub/launchd',
    'shared/install-root.ts',
    'shared/state-directory.ts',
    'shared/config-directory.ts',
    'shared/machine-config.ts',
    'shared/env-source.ts',
    DIST_MANIFEST,
    'bin/orch',
    'bin/hub',
  ])
})

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
