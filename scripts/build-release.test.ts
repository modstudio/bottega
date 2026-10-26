import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../shared/brand.ts'
import { DIST_MANIFEST } from '../shared/install-root.ts'
import {
  DECLARED_PAYLOAD_PATHS,
  distributionManifest,
  ORCH_CLI_PAYLOAD,
  PRODUCT_CLI_PAYLOAD,
  RELEASE_CLI_BUNDLES,
  releaseVersion,
  run,
} from './build-release.ts'

test('native CLI bundles use payload directories', () => {
  expect(RELEASE_CLI_BUNDLES).toEqual([
    {
      source: 'orchestrator/src/cli/orch.ts',
      payload: ORCH_CLI_PAYLOAD,
      output: 'directory',
    },
    { source: 'hub/src/cli.ts', payload: 'hub/src/cli.ts', output: 'file' },
    {
      source: `cli/${PLATFORM_SLUG}.ts`,
      payload: PRODUCT_CLI_PAYLOAD,
      output: 'directory',
    },
    {
      source: 'orchestrator/src/run/exec.ts',
      payload: 'orchestrator/src/run/exec.ts',
      output: 'file',
    },
    {
      source: 'retrieval/src/search-cli.ts',
      payload: 'retrieval/src/search-cli.ts',
      output: 'file',
    },
  ])
})

test('the payload has only the declared runtime paths', () => {
  expect(DECLARED_PAYLOAD_PATHS).toEqual([
    ORCH_CLI_PAYLOAD,
    'hub/src/cli.ts',
    PRODUCT_CLI_PAYLOAD,
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
    `bin/${PLATFORM_SLUG}`,
    'bin/retrieval-search',
  ])
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
