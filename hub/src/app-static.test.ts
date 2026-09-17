import { describe, expect, test } from 'bun:test'
import { appStaticPath, resolveAppStatic } from './app-static.ts'

describe('resolveAppStatic', () => {
  test('reports an unbuilt app', () => {
    expect(resolveAppStatic('/', false)).toEqual({ kind: '503' })
  })

  test('falls back to the SPA index for routes', () => {
    expect(resolveAppStatic('/projects', true)).toEqual({
      kind: 'index',
      relativePath: 'index.html',
    })
  })

  test('resolves static assets as files', () => {
    expect(resolveAppStatic('/assets/app.js', true)).toEqual({
      kind: 'file',
      relativePath: 'assets/app.js',
    })
  })
})

describe('appStaticPath', () => {
  test('separates the dist directory from the asset', () => {
    const index = resolveAppStatic('/projects', true) as {
      kind: 'index'
      relativePath: 'index.html'
    }
    expect(appStaticPath('/app/hub/web/dist', index)).toBe('/app/hub/web/dist/index.html')
  })

  test('separates a nested asset', () => {
    const asset = resolveAppStatic('/assets/app.js', true) as { kind: 'file'; relativePath: string }
    expect(appStaticPath('/app/hub/web/dist', asset)).toBe('/app/hub/web/dist/assets/app.js')
  })
})
