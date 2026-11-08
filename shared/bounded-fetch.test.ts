import { expect, test } from 'bun:test'
import { boundedFetch } from './bounded-fetch.ts'

test('preserves Request options when init does not override them', async () => {
  const originalFetch = globalThis.fetch
  let received: Request | undefined
  let receivedInit: RequestInit | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    received = input instanceof Request ? input : new Request(input, init)
    receivedInit = init
    return new Response('ok')
  }) as typeof fetch
  try {
    const request = new Request('https://example.test', {
      credentials: 'omit',
      headers: { 'x-request-option': 'preserved' },
      integrity: 'sha256-test',
      redirect: 'manual',
      referrer: 'https://referrer.example/',
      referrerPolicy: 'origin',
    })
    // Bun drops these RequestInit fields; model the fetch-compatible Request shape other runtimes
    // expose so the bounded transport must preserve it.
    Object.defineProperties(request, {
      credentials: { value: 'omit' },
      integrity: { value: 'sha256-test' },
      referrer: { value: 'https://referrer.example/' },
      referrerPolicy: { value: 'origin' },
    })
    await boundedFetch('hosted-api')(request)
    expect(receivedInit).toMatchObject({
      credentials: 'omit',
      integrity: 'sha256-test',
      redirect: 'manual',
      referrer: 'https://referrer.example/',
      referrerPolicy: 'origin',
    })
    expect(received?.headers.get('x-request-option')).toBe('preserved')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves response URL, redirect, and type metadata', async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      '/redirect': (request) => Response.redirect(new URL('/final', request.url)),
      '/final': new Response('ok'),
    },
  })
  const redirectUrl = new URL('/redirect', server.url)
  try {
    const native = await fetch(redirectUrl)
    const bounded = await boundedFetch('hosted-api')(redirectUrl)
    expect({ url: bounded.url, redirected: bounded.redirected, type: bounded.type }).toEqual({
      url: native.url,
      redirected: native.redirected,
      type: native.type,
    })
  } finally {
    server.stop(true)
  }
})
