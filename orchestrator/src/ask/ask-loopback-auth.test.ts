import { expect, test } from 'bun:test'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { addRun } from '../../test/fixtures/store.ts'
import { startAskLoopback } from './ask.ts'
import {
  ASK_AUTH_PREAMBLE_MAX_BYTES,
  askAuthPreamble,
  authenticateAskLoopbackSocket,
} from './ask-loopback-auth.ts'

const TOKEN = 'run-token-for-test'

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

async function authServer(timeoutMs = 100): Promise<{
  server: Server
  port: number
  authenticated: () => number
}> {
  let count = 0
  const server = createServer((socket) => {
    void authenticateAskLoopbackSocket(socket, TOKEN, timeoutMs).then((accepted) => {
      if (accepted) count += 1
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('auth server did not bind a TCP port')
  return { server, port: address.port, authenticated: () => count }
}

async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function refusal(payload: string | null, timeoutMs?: number): Promise<number> {
  const fixture = await authServer(timeoutMs)
  const socket = await connect(fixture.port)
  const didClose = closed(socket)
  if (payload !== null) socket.write(payload)
  await didClose
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  return fixture.authenticated()
}

test('the client auth preamble has the exact wire shape', () => {
  expect(askAuthPreamble(TOKEN)).toBe(
    `${JSON.stringify({ bottega_ask_auth: { run_token: TOKEN } })}\n`,
  )
})

test('tokenless and wrong-token connections close before authentication', async () => {
  expect(await refusal('{"jsonrpc":"2.0","method":"tools/list"}\n')).toBe(0)
  expect(await refusal(askAuthPreamble('wrong-token'))).toBe(0)
})

test('oversized and timed-out preambles close before authentication', async () => {
  expect(await refusal('x'.repeat(ASK_AUTH_PREAMBLE_MAX_BYTES + 1))).toBe(0)
  expect(await refusal(null, 20)).toBe(0)
})

test('a valid preamble followed by MCP bytes in one write reaches tools/list', async () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const loopback = await startAskLoopback(run, TOKEN)
  if (loopback.kind !== 'stdio-loopback') throw new Error('expected a stdio loopback')
  const port = Number(new URL(loopback.url).port)
  const socket = await connect(port)
  let received = ''
  socket.on('data', (chunk) => {
    received += chunk.toString()
  })
  try {
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ask-auth-test', version: '1' },
      },
    })
    const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    socket.write(`${askAuthPreamble(TOKEN)}${initialize}\n${initialized}\n${toolsList}\n`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('tools/list response timed out')), 500)
      const poll = () => {
        const response = received
          .split('\n')
          .some((line) => line.includes('"id":2') && line.includes('"tools"'))
        if (response) {
          clearTimeout(timeout)
          resolve()
        } else setTimeout(poll, 5)
      }
      poll()
    })
    expect(received).toContain('"tools"')
  } finally {
    socket.destroy()
    await loopback.close()
  }
})
