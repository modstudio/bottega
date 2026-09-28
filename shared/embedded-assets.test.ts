import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from './brand.ts'
import { readInstallAsset, registerEmbeddedAssets } from './embedded-assets.ts'

const manifest = {
  name: PLATFORM_NAME,
  version: '1.2.3',
  built: '2026-09-18T12:34:56.000Z',
  commit: 'abcdef1234567890',
} as const

afterEach(() => registerEmbeddedAssets(null))

test('the install asset reader falls back to disk only while the registry is empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'embedded-assets-'))
  const path = join(root, 'asset.txt')
  try {
    writeFileSync(path, 'from disk')
    expect(readInstallAsset('asset.txt', path)).toBe('from disk')
    registerEmbeddedAssets({ assets: { 'asset.txt': 'from registry' }, manifest })
    expect(readInstallAsset('asset.txt', path)).toBe('from registry')
    expect(() => readInstallAsset('missing.txt', path)).toThrow(
      'compiled missing.txt asset is missing',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
