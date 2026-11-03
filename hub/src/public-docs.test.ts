import { expect, test } from 'bun:test'
import { configureRecordApiUrl } from '../test/record-api-config.ts'
import { publicDoc, publicDocSearch, publicDocsTree } from './public-docs.ts'
import { publicDocsRouter } from './trpc/routers/public-docs.ts'

test('public doc helpers accept only the record-route inputs', () => {
  expect(publicDocsTree.length).toBe(0)
  expect(publicDoc.length).toBe(1)
  expect(publicDocSearch.length).toBe(1)
})

test('public doc procedures build their client from the configured record address', async () => {
  const clear = configureRecordApiUrl()
  const originalFetch = globalThis.fetch
  let requested = ''
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input)
      return Response.json({ items: [] })
    }) as typeof fetch

    await expect(publicDocsRouter.createCaller({}).tree()).resolves.toEqual({ items: [] })
    expect(requested).toBe('https://configured-record.example.test/public/v1/docs')
  } finally {
    globalThis.fetch = originalFetch
    clear()
  }
})
