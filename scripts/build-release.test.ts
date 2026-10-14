import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_NAME } from '../shared/brand.ts'
import { distributionManifest, releaseVersion, run } from './build-release.ts'

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
