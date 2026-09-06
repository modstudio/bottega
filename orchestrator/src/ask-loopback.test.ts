import { expect, test } from 'bun:test'
import { createConnection } from 'node:net'
import { startAskLoopback } from './ask.ts'

test('host ask loopback serves the existing JSON-RPC protocol on an OS-assigned port', async () => {
  const loopback = await startAskLoopback(1, 'fixture-token')
  const url = new URL(loopback.url)
  const socket = createConnection({ host: url.hostname, port: Number(url.port) })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
  const reply = await new Promise<string>((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString()))
    socket.once('error', reject)
  })
  socket.destroy()
  await loopback.close()

  const parsed = JSON.parse(reply.trim()) as { result: { tools: { name: string }[] } }
  expect(parsed.result.tools.map((tool) => tool.name)).toContain('ask_orchestrator')
})
