import { afterEach, describe, expect, test } from 'bun:test'
import { Mcp, type McpExchange } from './mcp.ts'

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

  test('allows the evidence harness to override the requested protocol version', async () => {
    let requestedProtocolVersion: unknown
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as {
        id?: number
        method: string
        params?: { protocolVersion?: unknown }
      }
      if (message.method === 'initialize')
        requestedProtocolVersion = message.params?.protocolVersion
      if (message.method === 'notifications/initialized') return new Response(null)
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2026-07-28', capabilities: {}, serverInfo: {} },
      })
    }) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'fixture', 30_000, null, '2026-07-28')

    await client.initialize()

    expect(requestedProtocolVersion).toBe('2026-07-28')
  })

  test('observes protocol and transport metadata without response content', async () => {
    const exchanges: McpExchange[] = []
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      const headers = new Headers({
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'must-not-be-recorded',
      })
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} }
          : { content: [{ type: 'text', text: '{"private":"response"}' }] }
      return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers })
    }) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'must-not-be-recorded', 30_000, (event) =>
      exchanges.push(event),
    )

    await client.initialize()
    await client.callTool('read-only', {})

    expect(exchanges[0]).toEqual({
      method: 'initialize',
      request: {
        accept: 'application/json, text/event-stream',
        contentType: 'application/json',
        mcpProtocolVersion: null,
        mcpSessionIdPresent: false,
      },
      response: {
        accept: null,
        contentType: 'application/json',
        mcpProtocolVersion: '2025-06-18',
        mcpSessionIdPresent: true,
        bodyFormat: 'json',
        status: 200,
      },
      answeredProtocolVersion: '2025-06-18',
    })
    expect(exchanges[1]?.request.mcpSessionIdPresent).toBe(true)
    expect(JSON.stringify(exchanges)).not.toContain('must-not-be-recorded')
    expect(JSON.stringify(exchanges)).not.toContain('private')
  })

  test('observes an unparseable successful response before reporting the parse failure', async () => {
    const exchanges: McpExchange[] = []
    globalThis.fetch = (async (_input, _init) =>
      new Response('must-not-be-recorded', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'mcp-protocol-version': '2026-07-28',
          'mcp-session-id': 'must-not-be-recorded',
        },
      })) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'must-not-be-recorded', 30_000, (event) =>
      exchanges.push(event),
    )

    let failure = ''
    try {
      await client.initialize()
    } catch (error) {
      failure = String(error)
    }

    expect(failure).toBe('McpError: unparseable response')
    expect(exchanges).toEqual([
      {
        method: 'initialize',
        request: {
          accept: 'application/json, text/event-stream',
          contentType: 'application/json',
          mcpProtocolVersion: null,
          mcpSessionIdPresent: false,
        },
        response: {
          accept: null,
          contentType: 'text/plain',
          mcpProtocolVersion: '2026-07-28',
          mcpSessionIdPresent: true,
          bodyFormat: 'unknown',
          status: 200,
        },
        answeredProtocolVersion: null,
      },
    ])
    expect(failure).not.toContain('must-not-be-recorded')
    expect(JSON.stringify(exchanges)).not.toContain('must-not-be-recorded')
  })
})
