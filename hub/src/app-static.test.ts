import { describe, expect, test } from 'bun:test'
import { resolveAppStatic } from './app-static.ts'

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
