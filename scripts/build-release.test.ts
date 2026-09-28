import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_NAME } from '../shared/brand.ts'
import { DIST_MANIFEST } from '../shared/install-root.ts'
import { embeddedAssetPaths } from './build-binary.ts'
import {
  DECLARED_PAYLOAD_PATHS,
  distributionManifest,
  releaseVersion,
  run,
} from './build-release.ts'

test('the payload has only the declared runtime paths', () => {
  expect(DECLARED_PAYLOAD_PATHS).toEqual([
    'orchestrator/src/cli/orch.ts',
    'hub/src/cli.ts',
    'orchestrator/src/run/exec.ts',
    'orchestrator/src/database/store-write-lock.c',
    'retrieval/src/search-cli.ts',
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
    'shared/attribution-markers.json',
    DIST_MANIFEST,
    'bin/orch',
    'bin/hub',
    'bin/retrieval-search',
  ])
})

test('binary asset paths include files below dot-prefixed directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binary-assets-'))
  try {
    mkdirSync(join(root, '.well-known'), { recursive: true })
    writeFileSync(join(root, 'app.js'), '')
    writeFileSync(join(root, '.well-known', 'assetlinks.json'), '')

    expect(await embeddedAssetPaths('hub/web/dist', root)).toEqual([
      'hub/web/dist/.well-known/assetlinks.json',
      'hub/web/dist/app.js',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the packaged hook reads its marker list from the release layout', async () => {
  const payload = mkdtempSync(join(tmpdir(), 'release-hook-'))
  const hook = join(payload, 'orchestrator', 'hooks', 'no-attribution.py')
  const markers = join(payload, 'shared', 'attribution-markers.json')
  mkdirSync(join(hook, '..'), { recursive: true })
  mkdirSync(join(markers, '..'), { recursive: true })
  copyFileSync(resolve('orchestrator/hooks/no-attribution.py'), hook)
  copyFileSync(resolve('shared/attribution-markers.json'), markers)
  const input = join(payload, 'input.json')
  writeFileSync(
    input,
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo harmless' },
      cwd: payload,
    }),
  )

  expect(await run(['python3', hook], payload, input)).toBe('')
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
