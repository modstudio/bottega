import { afterEach, describe, expect, test } from 'bun:test'
import {
  failureDetail,
  MCP_PROTOCOL_VERSION,
  Mcp,
  type McpExchange,
  mcpClientOptions,
} from './mcp.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Mcp tool discovery', () => {
  test('selects production auto negotiation and pins only modern evidence requests', () => {
    expect(mcpClientOptions()).toEqual({
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      versionNegotiation: { mode: 'auto' },
    })
    expect(mcpClientOptions('2025-11-25')).toEqual({
      supportedProtocolVersions: ['2025-11-25'],
      versionNegotiation: { mode: 'legacy' },
    })
    expect(mcpClientOptions('2026-07-28')).toEqual({
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
  })

  test('keeps only a redacted failure first line', () => {
    const detail = failureDetail(
      new Error('server refused token-value\nAuthorization: Bearer token-value'),
      'token-value',
    )

    expect(detail).toBe('server refused [redacted]')
    expect(detail).not.toContain('token-value')
    expect(detail).not.toContain('Authorization')
  })

  test('withholds secret-shaped failure details instead of partially redacting them', () => {
    expect(
      failureDetail(new Error('failure data: {"authorization":"Basic c2VjcmV0"}'), 'other'),
    ).toBe('[redacted]')
    expect(failureDetail(new Error('proxy-authorization: fixture-value'), 'other')).toBe(
      '[redacted]',
    )
    expect(failureDetail(new Error('Authorization: Basic c2VjcmV0'), 'other')).toBe('[redacted]')
    expect(failureDetail(new Error('server refused the requested protocol version'), 'other')).toBe(
      'server refused the requested protocol version',
    )
  })

  test('observes modern discovery and exposes its negotiated protocol version', async () => {
    const exchanges: McpExchange[] = []
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      expect(message.method).toBe('server/discover')
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          supportedVersions: ['2026-07-28'],
          capabilities: {},
        },
      })
    }) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'fixture', 30_000, (event) =>
      exchanges.push(event),
    )

    await client.initialize()

    expect(client.negotiatedProtocolVersion()).toBe('2026-07-28')
    expect(exchanges.map((exchange) => exchange.method)).toEqual(['server/discover'])
    expect(exchanges[0]?.answeredProtocolVersion).toBeNull()
    await client.close()
  })

  test('falls back to legacy initialization when discovery returns 404', async () => {
    const exchanges: McpExchange[] = []
    const methods: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      methods.push(message.method)
      if (message.method === 'server/discover') {
        return new Response('not found', { status: 404 })
      }
      if (message.method === 'notifications/initialized') return new Response(null)
      expect(message.method).toBe('initialize')
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        },
      })
    }) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'fixture', 30_000, (event) =>
      exchanges.push(event),
    )

    await client.initialize()

    expect(client.negotiatedProtocolVersion()).toBe('2025-11-25')
    expect(methods).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
    expect(exchanges.map((exchange) => exchange.method)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
    ])
    expect(exchanges[0]?.response.status).toBe(404)
    expect(exchanges[1]?.answeredProtocolVersion).toBe('2025-11-25')
    await client.close()
  })

  test('lists advertised tools without calling one', async () => {
    const methods: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      methods.push(message.method)
      if (message.method === 'notifications/initialized') return new Response(null)
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
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
    const client = new Mcp(
      'https://fixture.invalid/mcp',
      'fixture',
      30_000,
      null,
      MCP_PROTOCOL_VERSION,
    )

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
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'fixture', version: '1' },
        },
      })
    }) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'fixture', 30_000, null, '2025-06-18')

    await client.initialize()

    expect(requestedProtocolVersion).toBe('2025-06-18')
  })

  test('observes protocol and transport metadata without response content', async () => {
    const exchanges: McpExchange[] = []
    const authorizations: (string | null)[] = []
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      authorizations.push(new Headers(init?.headers).get('authorization'))
      const headers = new Headers({
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'must-not-be-recorded',
      })
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : { content: [{ type: 'text', text: '{"private":"response"}' }] }
      return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers })
    }) as typeof fetch
    const client = new Mcp(
      'https://fixture.invalid/mcp',
      'must-not-be-recorded',
      30_000,
      (event) => exchanges.push(event),
      '2025-06-18',
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
    expect(authorizations.at(-1)).toBe('Bearer must-not-be-recorded')
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
    const client = new Mcp(
      'https://fixture.invalid/mcp',
      'must-not-be-recorded',
      30_000,
      (event) => exchanges.push(event),
      MCP_PROTOCOL_VERSION,
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

  test('maps HTTP and protocol failures to condition-named McpError messages', async () => {
    globalThis.fetch = (async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (message.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          },
        })
      }
      if (message.method === 'notifications/initialized') return new Response(null)
      if (message.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32_601, message: 'fixture protocol failure' },
        })
      }
      return new Response('fixture transport failure', { status: 503 })
    }) as typeof fetch
    const client = new Mcp(
      'https://fixture.invalid/mcp',
      'fixture',
      30_000,
      null,
      MCP_PROTOCOL_VERSION,
    )

    await client.initialize()
    await expect(client.listTools()).rejects.toThrow(
      'tools/list: {"code":-32601,"message":"fixture protocol failure"}',
    )
    await expect(client.callTool('read-only', {})).rejects.toThrow(
      'HTTP 503: fixture transport failure',
    )
  })

  test('closes the standalone response stream and terminates the session', async () => {
    let openStreams = 0
    let terminatedSessions = 0
    let markStreamStarted: () => void = () => {}
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve
    })
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'GET') {
        openStreams++
        const signal = init.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                'abort',
                () => {
                  openStreams--
                  controller.error(signal.reason)
                },
                { once: true },
              )
              markStreamStarted()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (init?.method === 'DELETE') {
        terminatedSessions++
        return new Response(null)
      }

      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : { content: [{ type: 'text', text: '{}' }] }
      return Response.json(
        { jsonrpc: '2.0', id: message.id, result },
        message.method === 'initialize'
          ? { headers: { 'mcp-session-id': 'fixture-session' } }
          : undefined,
      )
    }) as typeof fetch
    const client = new Mcp(
      'https://fixture.invalid/mcp',
      'fixture',
      30_000,
      null,
      MCP_PROTOCOL_VERSION,
    )

    await client.initialize()
    await streamStarted
    await client.callTool('read-only', {})
    expect(openStreams).toBe(1)

    await client.close()

    expect(openStreams).toBe(0)
    expect(terminatedSessions).toBe(1)
  })

  test('keeps the standalone response stream open past the request timeout until close', async () => {
    let openStreams = 0
    let markStreamStarted: () => void = () => {}
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve
    })
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'GET') {
        openStreams++
        const signal = init.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                'abort',
                () => {
                  openStreams--
                  controller.error(signal.reason)
                },
                { once: true },
              )
              markStreamStarted()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (init?.method === 'DELETE') return new Response(null)

      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return Response.json(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fixture', version: '1' },
          },
        },
        { headers: { 'mcp-session-id': 'fixture-session' } },
      )
    }) as typeof fetch
    const client = new Mcp('https://fixture.invalid/mcp', 'fixture', 10, null, MCP_PROTOCOL_VERSION)

    await client.initialize()
    await streamStarted
    await Bun.sleep(30)

    expect(openStreams).toBe(1)
    await client.close()
    expect(openStreams).toBe(0)
  })

  test('closes the client without throwing when session termination fails', async () => {
    let openStreams = 0
    let markStreamStarted: () => void = () => {}
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve
    })
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'GET') {
        openStreams++
        const signal = init.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                'abort',
                () => {
                  openStreams--
                  controller.error(signal.reason)
                },
                { once: true },
              )
              markStreamStarted()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (init?.method === 'DELETE') return new Response('fixture failure', { status: 503 })

      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return Response.json(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fixture', version: '1' },
          },
        },
        { headers: { 'mcp-session-id': 'fixture-session' } },
      )
    }) as typeof fetch
    const client = new Mcp(
      'https://fixture.invalid/mcp',
      'fixture',
      30_000,
      null,
      MCP_PROTOCOL_VERSION,
    )

    await client.initialize()
    await streamStarted

    await expect(client.close()).resolves.toBeUndefined()
    expect(openStreams).toBe(0)
  })
})
