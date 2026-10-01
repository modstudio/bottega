import {
  Client,
  type FetchLike,
  LATEST_PROTOCOL_VERSION,
  ProtocolError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { readEnvValuesWithHosted } from '../../shared/env-source.ts'

class McpError extends Error {
  override name = 'McpError'
}

export const MCP_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION

type McpTransportHeaders = {
  accept: string | null
  contentType: string | null
  mcpProtocolVersion: string | null
  mcpSessionIdPresent: boolean
}

export type McpExchange = {
  method: string
  request: McpTransportHeaders
  response: McpTransportHeaders & {
    bodyFormat: 'empty' | 'json' | 'sse' | 'unknown'
    status: number
  }
  /** Present only on the initialize exchange. */
  answeredProtocolVersion: string | null
}

export type McpTool = {
  name: string
  inputSchema: {
    properties?: Record<string, unknown>
    [key: string]: unknown
  }
}

export class Mcp {
  private client: Client
  private transport: StreamableHTTPClientTransport
  private timeoutMs: number
  private observe: ((exchange: McpExchange) => void) | null

  constructor(
    url: string,
    token: string,
    timeoutMs = 30_000,
    observe: ((exchange: McpExchange) => void) | null = null,
    requestProtocolVersion = MCP_PROTOCOL_VERSION,
  ) {
    this.timeoutMs = timeoutMs
    this.observe = observe
    this.client = new Client(
      { name: 'hub', version: '0.1' },
      requestProtocolVersion === MCP_PROTOCOL_VERSION
        ? undefined
        : { supportedProtocolVersions: [requestProtocolVersion] },
    )
    this.transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: this.observedFetch,
    })
  }

  async initialize() {
    try {
      await this.client.connect(this.transport, { timeout: this.timeoutMs })
    } catch (error) {
      throw mappedFailure('initialize', error)
    }
  }

  async listTools(): Promise<McpTool[]> {
    try {
      const result = await this.client.listTools({}, { timeout: this.timeoutMs })
      return result.tools as McpTool[]
    } catch (error) {
      throw mappedFailure('tools/list', error)
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        { timeout: this.timeoutMs },
      )
      if (result.isError)
        throw new McpError(`${name} returned an error: ${JSON.stringify(result).slice(0, 200)}`)
      if (result.structuredContent) return result.structuredContent
      for (const item of result.content) {
        if (item.type === 'text') {
          try {
            return JSON.parse(item.text)
          } catch {
            return { text: item.text }
          }
        }
      }
      return result
    } catch (error) {
      throw mappedFailure(name, error)
    }
  }

  async close(): Promise<void> {
    try {
      await this.transport.terminateSession()
    } catch {
      // Session termination is best-effort; client.close still must stop the
      // standalone response stream and release the transport.
    } finally {
      await this.client.close()
    }
  }

  private observedFetch: FetchLike = async (input, init) => {
    const requestHeaders = requestHeadersFor(input, init)
    const message = requestMessage(init?.body)
    const requestSignal = init?.signal
    const signal =
      init?.method === 'GET'
        ? requestSignal
        : requestSignal
          ? AbortSignal.any([requestSignal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs)
    const response = await globalThis.fetch(input, { ...init, signal })
    if (!message) return response

    const raw = await response.clone().text()
    const parsed = parseResponse(raw)
    this.observe?.({
      method: typeof message.method === 'string' ? message.method : '(unknown)',
      request: transportHeaders(requestHeaders),
      response: {
        ...transportHeaders(response.headers),
        bodyFormat: responseBodyFormat(raw, response.headers.get('content-type')),
        status: response.status,
      },
      answeredProtocolVersion:
        message.method === 'initialize' ? initializeProtocolVersion(parsed) : null,
    })
    if (!response.ok) throw new McpError(`HTTP ${response.status}: ${raw.slice(0, 200)}`)
    if (raw && responseBodyFormat(raw, response.headers.get('content-type')) === 'unknown') {
      throw new McpError('unparseable response')
    }
    return response
  }
}

function mappedFailure(condition: string, error: unknown): McpError {
  if (error instanceof McpError) return error
  if (error instanceof ProtocolError) {
    const detail: Record<string, unknown> = { code: error.code, message: error.message }
    if (error.data !== undefined) detail.data = error.data
    return new McpError(`${condition}: ${JSON.stringify(detail)}`)
  }
  return new McpError(`${condition}: ${error instanceof Error ? error.message : String(error)}`)
}

function requestHeadersFor(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value)
  })
  return headers
}

function requestMessage(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== 'string') return null
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseResponse(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        return JSON.parse(line.slice(5).trim()) as Record<string, unknown>
      } catch {
        /* next */
      }
    }
    return {}
  }
}

function transportHeaders(headers: Headers): McpTransportHeaders {
  return {
    accept: headers.get('accept'),
    contentType: headers.get('content-type'),
    mcpProtocolVersion: headers.get('mcp-protocol-version'),
    mcpSessionIdPresent: headers.has('mcp-session-id'),
  }
}

function responseBodyFormat(
  raw: string,
  contentType: string | null,
): McpExchange['response']['bodyFormat'] {
  if (!raw) return 'empty'
  if (contentType?.toLowerCase().includes('text/event-stream') || /^data:/m.test(raw)) return 'sse'
  try {
    JSON.parse(raw)
    return 'json'
  } catch {
    return 'unknown'
  }
}

function initializeProtocolVersion(message: Record<string, unknown>): string | null {
  const result = message.result
  if (!result || typeof result !== 'object') return null
  const version = (result as { protocolVersion?: unknown }).protocolVersion
  return typeof version === 'string' ? version : null
}

/**
 * Credentials, resolved from the configured environment sources at use time.
 *
 * Never cached at import and never written to hub.db: the settings UI shows
 * whether a token resolves, never the token.
 */
export async function credentials(name: string): Promise<{ url: string; token: string } | null> {
  const urlName = `${name}_MCP_URL`
  const tokenName = `${name}_MCP_TOKEN`
  const values = await readEnvValuesWithHosted([urlName, tokenName])
  const url = values[urlName]
  const token = values[tokenName]
  return url && token ? { url, token } : null
}
