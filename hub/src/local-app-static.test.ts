import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../shared/embedded-assets.ts'
import { localAppStaticResponse } from './local-app-static.ts'

const manifest = {
  name: PLATFORM_NAME,
  version: 'test',
  built: '2026-09-28T00:00:00.000Z',
  commit: 'test',
} as const

afterEach(() => registerEmbeddedAssets(null))

test('the local static handler serves only files in the embedded registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-static-'))
  const index = join(root, 'index.html')
  const script = join(root, 'app-abc123.js')
  try {
    writeFileSync(index, '<html><div id="root"></div></html>')
    writeFileSync(script, 'console.log("embedded")')
    registerEmbeddedAssets({
      assets: {},
      files: {
        'hub/web/dist/index.html': index,
        'hub/web/dist/assets/app-abc123.js': script,
      },
      manifest,
    })

    const spa = await localAppStaticResponse('/projects/example')
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('<div id="root">')

    const asset = await localAppStaticResponse('/assets/app-abc123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(await asset.text()).toBe('console.log("embedded")')

    const missing = await localAppStaticResponse('/assets/missing.js')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('not found')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the local static handler returns the existing 503 when no index is embedded', async () => {
  registerEmbeddedAssets({ assets: {}, files: {}, manifest })
  const response = await localAppStaticResponse('/')
  expect(response.status).toBe(503)
  expect(await response.text()).toBe('hub/web is not built: cd hub/web && bun run build')
})
