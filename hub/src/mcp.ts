import { readEnvValuesWithHosted } from '../../shared/env-source.ts'

/**
 * Just enough Streamable HTTP MCP to call one tool.
 *
 * Ported from work-report's Python client, which had already learned the two
 * things that bite: a server may answer a tool call with either plain JSON or
 * an SSE stream, and the session id comes back on the initialize response as a
 * header rather than in the body.
 *
 * The servers are reached DIRECTLY over HTTPS. `~/.claude/mcp/mcp-run` wraps
 * them in supergateway to give Claude Code a stdio transport, but that is a
 * bridge for Claude Code's benefit — underneath, each is a plain endpoint with
 * a bearer token.
 */
class McpError extends Error {}

export type McpTool = {
  name: string
  inputSchema: {
    properties?: Record<string, unknown>
    [key: string]: unknown
  }
}

export class Mcp {
  private sessionId: string | null = null
  private nextId = 1
  private url: string
  private token: string
  private timeoutMs: number

  constructor(url: string, token: string, timeoutMs = 30_000) {
    this.url = url
    this.token = token
    this.timeoutMs = timeoutMs
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      // Both are required: a server may answer either way, and one that streams
      // will refuse a request that does not say it can read a stream.
      accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) h['mcp-session-id'] = this.sessionId
    return h
  }

  private async post(body: unknown, expectResponse = true) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (!res.ok) throw new McpError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    if (!expectResponse) return {}
    const raw = await res.text()
    if (!raw) return {}
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      // SSE fallback: find the first data: line carrying JSON-RPC.
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          return JSON.parse(line.slice(5).trim()) as Record<string, unknown>
        } catch {
          /* next */
        }
      }
      throw new McpError(`unparseable response: ${raw.slice(0, 200)}`)
    }
  }

  async initialize() {
    const r = (await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hub', version: '0.1' },
      },
    })) as { error?: unknown }
    if (r.error) throw new McpError(`initialize: ${JSON.stringify(r.error)}`)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  }

  async listTools(): Promise<McpTool[]> {
    const r = (await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
      params: {},
    })) as { error?: unknown; result?: { tools?: McpTool[] } }
    if (r.error) throw new McpError(`tools/list: ${JSON.stringify(r.error)}`)
    return r.result?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const r = (await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    })) as { error?: unknown; result?: Record<string, unknown> }
    if (r.error) throw new McpError(`${name}: ${JSON.stringify(r.error)}`)
    const res = r.result ?? {}
    if (res.isError)
      throw new McpError(`${name} returned an error: ${JSON.stringify(res).slice(0, 200)}`)
    if (res.structuredContent) return res.structuredContent
    for (const item of (res.content as { type?: string; text?: string }[] | undefined) ?? []) {
      if (item.type === 'text' && typeof item.text === 'string') {
        try {
          return JSON.parse(item.text)
        } catch {
          return { text: item.text }
        }
      }
    }
    return res
  }
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
