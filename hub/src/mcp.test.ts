import { afterEach, describe, expect, test } from 'bun:test'
import { Mcp } from './mcp.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Mcp tool discovery', () => {
  test('lists advertised tools without calling one', async () => {
    const methods: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      methods.push(message.method)
      if (message.method === 'notifications/initialized') return new Response(null)
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} }
          : {
              tools: [
                {
                  name: 'create-task-tool',
                  inputSchema: { type: 'object', properties: { status: {} } },
                },
              ],
            }
      return Response.json({ jsonrpc: '2.0', id: message.id, result })
    }) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'fixture')

    await client.initialize()
    expect(await client.listTools()).toEqual([
      {
        name: 'create-task-tool',
        inputSchema: { type: 'object', properties: { status: {} } },
      },
    ])
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  })
})
