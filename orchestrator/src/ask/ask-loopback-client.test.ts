import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import {
  askProxyConnectOptions,
  decideAskLoopbackConnection,
  openAskLoopbackSocket,
} from './ask-loopback-client.ts'

const ASK_URL = 'tcp://127.0.0.1:43127'

test('the connection decision tunnels only on Linux with a proxy', () => {
  expect(
    decideAskLoopbackConnection({
      platform: 'darwin',
      askUrl: ASK_URL,
      HTTP_PROXY: 'http://127.0.0.1:8123',
    }),
  ).toEqual({ kind: 'direct', host: '127.0.0.1', port: 43127, linuxWithoutProxy: false })
  expect(
    decideAskLoopbackConnection({
      platform: 'linux',
      askUrl: ASK_URL,
      HTTP_PROXY: 'http://127.0.0.1:8123',
    }),
  ).toEqual({
    kind: 'tunnel',
    askHost: '127.0.0.1',
    askPort: 43127,
    proxy: 'http://127.0.0.1:8123',
  })
  expect(decideAskLoopbackConnection({ platform: 'linux', askUrl: ASK_URL })).toEqual({
    kind: 'direct',
    host: '127.0.0.1',
    port: 43127,
    linuxWithoutProxy: true,
  })
  expect(
    decideAskLoopbackConnection({
      platform: 'linux',
      askUrl: ASK_URL,
      http_proxy: 'http://127.0.0.1:8124',
    }),
  ).toMatchObject({ kind: 'tunnel', proxy: 'http://127.0.0.1:8124' })
})

test('the connection decision refuses a non-loopback or non-tcp ask URL', () => {
  expect(() => decideAskLoopbackConnection({ platform: 'darwin', askUrl: 'http://127.0.0.1:1' })).toThrow(
    'BOTTEGA_ASK_URL must name a tcp://127.0.0.1:<port> endpoint',
  )
  expect(() => decideAskLoopbackConnection({ platform: 'darwin', askUrl: 'tcp://localhost:1' })).toThrow(
    'BOTTEGA_ASK_URL must name a tcp://127.0.0.1:<port> endpoint',
  )
})

test('CONNECT options carry the target and optional proxy credentials', () => {
  expect(askProxyConnectOptions('http://proxy.test:8080', '127.0.0.1', 43127)).toEqual({
    host: 'proxy.test',
    port: 8080,
    method: 'CONNECT',
    path: '127.0.0.1:43127',
    headers: { Host: '127.0.0.1:43127' },
  })
  expect(askProxyConnectOptions('http://worker:secret@proxy.test:8080', '127.0.0.1', 43127)).toEqual({
    host: 'proxy.test',
    port: 8080,
    method: 'CONNECT',
    path: '127.0.0.1:43127',
    headers: {
      Host: '127.0.0.1:43127',
      'Proxy-Authorization': `Basic ${Buffer.from('worker:secret').toString('base64')}`,
    },
  })
})

test('a Linux direct failure names the SRT network bridge remedy', async () => {
  await expect(
    openAskLoopbackSocket({
      kind: 'direct',
      host: '127.0.0.1',
      port: 1,
      linuxWithoutProxy: true,
    }),
  ).rejects.toThrow("Run the worker under SRT's network bridge")
})

test('CONNECT tunnels through an in-process proxy without exposing its credential on failure', async () => {
  const seen: { path?: string; authorization?: string } = {}
  const proxy = createServer()
  proxy.on('connect', (request, socket) => {
    seen.path = request.url
    seen.authorization = request.headers['proxy-authorization']
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('proxy did not bind a TCP port')
  let tunnel: Socket | undefined
  try {
    tunnel = await openAskLoopbackSocket({
      kind: 'tunnel',
      askHost: '127.0.0.1',
      askPort: 43127,
      proxy: `http://worker:secret@127.0.0.1:${address.port}`,
    })
    const echoed = new Promise<string>((resolve) => tunnel!.once('data', (data) => resolve(data.toString())))
    tunnel.write('through')
    expect(await echoed).toBe('through')
    expect(seen).toEqual({
      path: '127.0.0.1:43127',
      authorization: `Basic ${Buffer.from('worker:secret').toString('base64')}`,
    })
  } finally {
    tunnel?.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }

  await expect(
    openAskLoopbackSocket({
      kind: 'tunnel',
      askHost: '127.0.0.1',
      askPort: 43127,
      proxy: 'http://worker:secret@127.0.0.1:1',
    }),
  ).rejects.not.toThrow(/worker|secret/)
})
