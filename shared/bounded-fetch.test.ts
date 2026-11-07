import { expect, test } from 'bun:test'
import { boundedFetch } from './bounded-fetch.ts'

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
