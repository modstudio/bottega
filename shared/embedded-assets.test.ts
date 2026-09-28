import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from './brand.ts'
import { readInstallAsset, registerEmbeddedAssets, resolveInstallFile } from './embedded-assets.ts'

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
    registerEmbeddedAssets({
      assets: { 'asset.txt': 'from registry' },
      files: { 'hub/web/dist/index.html': '/$bunfs/root/index.html' },
      manifest,
    })
    expect(readInstallAsset('asset.txt', path)).toBe('from registry')
    expect(() => readInstallAsset('missing.txt', path)).toThrow(
      'compiled missing.txt asset is missing',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the install file reader uses only registered paths inside a binary', () => {
  const diskPath = '/checkout/hub/web/dist/index.html'
  expect(resolveInstallFile('hub/web/dist/index.html', diskPath)).toBe(diskPath)

  registerEmbeddedAssets({
    assets: {},
    files: { 'hub/web/dist/index.html': '/$bunfs/root/index.html' },
    manifest,
  })
  expect(resolveInstallFile('hub/web/dist/index.html', diskPath)).toBe('/$bunfs/root/index.html')
  expect(resolveInstallFile('hub/web/dist/missing.js', diskPath)).toBeUndefined()
  expect(resolveInstallFile('hub/web/dist/../../x', diskPath)).toBeUndefined()
})
