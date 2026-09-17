import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** True when a transcript contains a completed MCP/tool call the probe can observe. */
export function mcpToolCallsObservable(
  events: { kind: string; status?: string }[],
  output: string,
): boolean {
  const tools = events.filter((event) => event.kind === 'tool')
  if (tools.some((event) => event.status === 'completed')) return true
  return /\bping\b/i.test(output) && /\bpong\b/i.test(output)
}

/** Mint a one-tool stdio MCP server used by the registration MCP probe. */
export function mintStdioPingServer(dir: string): string {
  const server = join(dir, 'minted-mcp-server.ts')
  writeFileSync(
    server,
    `
let buf = Buffer.alloc(0)
const reply = (id, result) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n')
  process.stdout.write(body)
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (true) {
    const text = buf.toString('utf8')
    const match = /^Content-Length:\\s*(\\d+)\\r\\n\\r\\n/.exec(text)
    if (!match) return
    const offset = match[0].length
    const length = Number(match[1])
    if (buf.length < offset + length) return
    const message = JSON.parse(buf.subarray(offset, offset + length).toString('utf8'))
    buf = buf.subarray(offset + length)
    if (message.method === 'initialize') reply(message.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'minted' } })
    else if (message.method === 'tools/list') reply(message.id, { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] })
    else if (message.method === 'tools/call') reply(message.id, { content: [{ type: 'text', text: 'pong' }] })
  }
})
`,
  )
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: { minted: { command: process.execPath, args: [server] } },
    }),
  )
  return server
}

export type McpProbeResult = {
  server: string
  tool: string
  ok: boolean
  error: string | null
  durationMs: number
  detail: string | null
  namesSeen: string[]
}

export type McpServerConfig = {
  name: string
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

/** Return checkout servers withheld from this project's workers. */
export function disabledProjectMcpServers(
  names: string[],
  allowed: string[] | undefined,
): string[] {
  if (allowed === undefined) return []
  const allow = new Set(allowed)
  return names.filter((name) => !allow.has(name))
}

const ALLOWED_EXTRA_SERVERS = new Set(['orch-ask', 'orch'])
const MCP_PROBE_ERROR_LIMIT = 400

/** Remove configured credentials from probe errors before they become durable evidence. */
function sanitizeProbeError(text: string, secrets: string[]): string {
  let sanitized = text
  const longestFirst = [...new Set(secrets.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  )
  for (const secret of longestFirst) sanitized = sanitized.replaceAll(secret, '[redacted]')
  return sanitized.slice(0, MCP_PROBE_ERROR_LIMIT)
}

function probeSecrets(config: McpServerConfig | undefined): string[] {
  const headers = Object.values(config?.headers ?? {})
  const headerTokens = headers.flatMap((value) =>
    value.split(/\s+/).filter((token) => token.length >= 8),
  )
  const env = Object.values(config?.env ?? {}).filter((value) => value.length >= 8)
  return [...headers.filter(Boolean), ...headerTokens, ...env]
}

export function namesSeenAt(cwd: string): string[] {
  return [...new Set([...Object.keys(readMcpConfig(cwd)), ...ALLOWED_EXTRA_SERVERS])]
}

function parseMcpConfig(source: string): Record<string, McpServerConfig> {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const root = parsed as Record<string, unknown>
  const servers = (root.mcpServers ?? root.servers ?? {}) as Record<string, unknown>
  const out: Record<string, McpServerConfig> = {}
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const headers =
      entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
        ? Object.fromEntries(
            Object.entries(entry.headers as Record<string, unknown>).filter(
              (item): item is [string, string] => typeof item[1] === 'string',
            ),
          )
        : undefined
    out[name] = {
      name,
      url: typeof entry.url === 'string' ? entry.url : undefined,
      command: typeof entry.command === 'string' ? entry.command : undefined,
      args: Array.isArray(entry.args)
        ? entry.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      env:
        entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
          ? Object.fromEntries(
              Object.entries(entry.env as Record<string, unknown>).filter(
                (item): item is [string, string] => typeof item[1] === 'string',
              ),
            )
          : undefined,
      ...(headers === undefined ? {} : { headers }),
    }
  }
  return out
}

export function readMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const path = join(cwd, '.mcp.json')
  if (!existsSync(path)) return {}
  try {
    return parseMcpConfig(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function mcpEndpointAllowlist(url: string | null | undefined): string[] {
  if (!url) return []
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    if (!host) return []
    const names = [host]
    if (parsed.port) names.push(`${host}:${parsed.port}`)
    return names
  } catch {
    return []
  }
}

export function mcpConfigAllowlist(
  config: Record<string, McpServerConfig> | null | undefined,
): string[] {
  return [
    ...new Set(Object.values(config ?? {}).flatMap((server) => mcpEndpointAllowlist(server.url))),
  ]
}

/**
 * A tree is the wrong project's only when the REQUIRED server is absent and
 * another project's server is what the tree sees instead (DEV-194's shape: a
 * worktree discovering a different .mcp.json). Bottega's tracked .mcp.json
 * registers every project's server deliberately, so extra names beside a
 * present required server are not evidence of anything.
 */
export function wrongProjectReason(required: string, namesSeen: string[]): string | null {
  if (ALLOWED_EXTRA_SERVERS.has(required)) return null
  if (namesSeen.includes(required)) return null
  const extra = namesSeen.filter((name) => name && !ALLOWED_EXTRA_SERVERS.has(name))
  return extra.length ? `wrong project: saw ${extra.join(', ')} and not ${required}` : null
}

function encodeMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

function decodeMessages(buffer: Buffer): unknown[] {
  const messages: unknown[] = []
  let rest = buffer
  while (rest.length) {
    const header = rest.toString('utf8')
    const match = /^Content-Length:\s*(\d+)\r\n\r\n/i.exec(header)
    if (match) {
      const offset = match[0].length
      const length = Number(match[1])
      if (rest.length < offset + length) break
      const body = rest.subarray(offset, offset + length).toString('utf8')
      try {
        messages.push(JSON.parse(body))
      } catch {
        /* skip malformed */
      }
      rest = rest.subarray(offset + length)
      continue
    }
    const line = header.split('\n')[0] ?? ''
    if (!line.trim()) break
    try {
      messages.push(JSON.parse(line.trim()))
    } catch {
      /* skip */
    }
    const consumed = Buffer.from(line + (header.startsWith(line + '\n') ? '\n' : '')).length
    rest = rest.subarray(Math.max(consumed, 1))
  }
  return messages
}

async function stdioRpc(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  messages: unknown[],
  timeoutMs = 8_000,
): Promise<{ ok: boolean; messages: unknown[]; error: string | null }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const writer = proc.stdin
  if (!writer) {
    proc.kill()
    return { ok: false, messages: [], error: 'stdio MCP server has no stdin' }
  }
  for (const message of messages) writer.write(encodeMessage(message))
  writer.end()
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* gone */
    }
  }, timeoutMs)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ])
  const exit = await proc.exited
  clearTimeout(timer)
  const decoded = decodeMessages(Buffer.from(stdout))
  if (!decoded.length && exit !== 0) {
    return { ok: false, messages: [], error: stderr.trim() || `stdio MCP server exited ${exit}` }
  }
  return { ok: true, messages: decoded, error: stderr.trim() || null }
}

async function httpRpc(
  url: string,
  messages: unknown[],
  headers: Record<string, string> | undefined,
  cwd: string,
  env: Record<string, string>,
  wrap?: (command: string, args: string[]) => string[] | Promise<string[]>,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; messages: unknown[]; error: string | null }> {
  const replies: unknown[] = []
  const script = `const url=process.argv[1], body=process.argv[2];
const configured=JSON.parse(await Bun.stdin.text());
const headers=new Headers({'content-type':'application/json',accept:'application/json, text/event-stream'});
for(const [name,value] of Object.entries(configured))headers.set(name,value);
const res=await fetch(url,{method:'POST',headers,body});
const text=await res.text(); process.stdout.write(text); process.exit(res.ok?0:1)`
  for (const message of messages) {
    if (
      typeof message === 'object' &&
      message &&
      'method' in message &&
      String((message as { method: string }).method).startsWith('notifications/')
    ) {
      continue
    }
    const raw = [process.execPath, '-e', script, url, JSON.stringify(message)]
    const argv = wrap ? await wrap(raw[0]!, raw.slice(1)) : raw
    const proc = Bun.spawn(argv, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    proc.stdin.write(JSON.stringify(headers ?? {}))
    proc.stdin.end()
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* gone */
      }
    }, timeoutMs)
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    if (exit !== 0) {
      const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      // Unbounded here: sanitizeProbeError bounds after redacting, so no cut can split a secret.
      return { ok: false, messages: replies, error: combined || `HTTP probe exited ${exit}` }
    }
    try {
      replies.push(JSON.parse(stdout))
    } catch {
      return { ok: false, messages: replies, error: stdout || 'HTTP probe returned non-JSON' }
    }
  }
  return { ok: true, messages: replies, error: null }
}

function toolNames(messages: unknown[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const result = (message as { result?: { tools?: { name?: string }[] } }).result
    for (const tool of result?.tools ?? []) if (tool.name) names.push(tool.name)
  }
  return names
}

export async function probeMcpServer(input: {
  server: string
  config: McpServerConfig | undefined
  cwd: string
  env: Record<string, string>
  probeTool?: string | null
  wrap?: (command: string, args: string[]) => string[] | Promise<string[]>
}): Promise<McpProbeResult> {
  const started = Date.now()
  const namesSeen = namesSeenAt(input.cwd)
  const secrets = probeSecrets(input.config)
  const fail = (error: string, tool = 'tools/list'): McpProbeResult => ({
    server: input.server,
    tool,
    ok: false,
    error: sanitizeProbeError(error, secrets),
    durationMs: Date.now() - started,
    detail: null,
    namesSeen,
  })
  if (!input.config) return fail(`MCP server '${input.server}' is not in .mcp.json`)
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orch', version: '0.1.0' },
    },
  }
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  let rpc: { ok: boolean; messages: unknown[]; error: string | null }
  if (input.config.url) {
    rpc = await httpRpc(
      input.config.url,
      [initialize, initialized, list],
      input.config.headers,
      input.cwd,
      input.env,
      input.wrap,
    )
  } else if (input.config.command) {
    const raw = [input.config.command, ...(input.config.args ?? [])]
    const command = input.wrap ? await input.wrap(raw[0]!, raw.slice(1)) : raw
    const bin = command[0]!
    const args = command.slice(1)
    const resolved = isAbsolute(bin) || bin.includes('/') ? bin : (Bun.which(bin) ?? bin)
    rpc = await stdioRpc(resolved, args, input.cwd, { ...input.env, ...(input.config.env ?? {}) }, [
      initialize,
      initialized,
      list,
    ])
  } else {
    return fail(`MCP server '${input.server}' has neither url nor command`)
  }
  if (!rpc.ok) return fail(rpc.error ?? 'MCP probe failed')
  const listed = toolNames(rpc.messages)
  const listError = rpc.messages
    .map((message) => {
      const error = (message as { error?: { message?: string } })?.error
      return error?.message
    })
    .find(Boolean)
  if (listError && !listed.length) return fail(listError)
  const result: McpProbeResult = {
    server: input.server,
    tool: 'tools/list',
    ok: true,
    error: null,
    durationMs: Date.now() - started,
    detail: `listed: ${listed.length} tools`,
    namesSeen,
  }
  if (!input.probeTool) return result
  const call = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: input.probeTool, arguments: {} },
  }
  const stdioArgv = input.config.command
    ? input.wrap
      ? await input.wrap(input.config.command, input.config.args ?? [])
      : [input.config.command, ...(input.config.args ?? [])]
    : null
  const called = input.config.url
    ? await httpRpc(
        input.config.url,
        [call],
        input.config.headers,
        input.cwd,
        input.env,
        input.wrap,
      )
    : stdioArgv
      ? await stdioRpc(
          stdioArgv[0]!,
          stdioArgv.slice(1),
          input.cwd,
          { ...input.env, ...(input.config.env ?? {}) },
          [initialize, initialized, call],
        )
      : { ok: false, messages: [], error: 'no transport' }
  result.tool = input.probeTool
  result.durationMs = Date.now() - started
  if (!called.ok) {
    result.ok = false
    result.error = called.error === null ? null : sanitizeProbeError(called.error, secrets)
    return result
  }
  const callError = called.messages
    .map((message) => {
      const error = (message as { error?: { message?: string } })?.error
      return error?.message
    })
    .find(Boolean)
  if (callError) {
    result.ok = false
    result.error = sanitizeProbeError(callError, secrets)
    return result
  }
  result.detail = `listed: ${listed.length} tools; called ${input.probeTool}`
  return result
}

export function storedMcpProbe(result: McpProbeResult): string {
  return JSON.stringify(result)
}

export function parseMcpProbe(value: string | null | undefined): McpProbeResult | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as McpProbeResult
    if (typeof parsed?.ok !== 'boolean' || typeof parsed.server !== 'string') return null
    if (!Array.isArray(parsed.namesSeen) || typeof parsed.durationMs !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export type McpCallEvidence = { connected: 0 | 1 | null; error: string | null }

/** Connection evidence means a successful named tool call, never a handshake. */
export function mcpCallEvidence(result: McpProbeResult | null): McpCallEvidence {
  if (!result) return { connected: null, error: 'unverified: no tool call observed' }
  if (!result.ok) return { connected: 0, error: result.error ?? 'MCP probe failed' }
  if (result.tool === 'tools/list') {
    return { connected: null, error: 'unverified: no tool call observed' }
  }
  return { connected: 1, error: `verified: successful tool call ${result.tool}` }
}
