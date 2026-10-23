import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decodeMessages,
  disabledProjectMcpServers,
  mcpCallEvidence,
  mintStdioPingServer,
  probeMcpServer,
  readMcpConfig,
} from './mcp-probe.ts'

test('computes the complement only for declared worker MCP scope', () => {
  const names = ['orch', 'starship', 'stopal']
  expect(disabledProjectMcpServers(names, undefined)).toEqual([])
  expect(disabledProjectMcpServers(names, [])).toEqual(names)
  expect(disabledProjectMcpServers(names, ['starship'])).toEqual(['orch', 'stopal'])
})

test('a successful orchestrator tool probe leaves worker attachment unverified', () => {
  expect(
    mcpCallEvidence({
      server: 'starship',
      tool: 'task_list',
      ok: true,
      error: null,
      durationMs: 12,
      detail: 'called task_list',
      namesSeen: ['starship'],
    }),
  ).toEqual({
    connected: null,
    error: `${PLATFORM_SLUG} agent probe ok: task_list; worker attachment unverified`,
  })
})

test('the newline-only minted server answers initialize, tools/list and tools/call through the probe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-probe-newline-'))
  mintStdioPingServer(dir)
  const result = await probeMcpServer({
    server: 'minted',
    config: readMcpConfig(dir).minted,
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
    probeTool: 'ping',
  })
  expect(result.ok).toBe(true)
  expect(result.listedTools).toEqual(['ping'])
  expect(result.tool).toBe('ping')
  expect(result.detail).toBe('listed: 1 tools; called ping')
})

test('a tools/call result with isError fails the in-process probe and sanitizes its text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-probe-error-'))
  mintStdioPingServer(dir, 'refused secret-value-123')
  const result = await probeMcpServer({
    server: 'minted',
    config: { ...readMcpConfig(dir).minted!, env: { TOKEN: 'secret-value-123' } },
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
    probeTool: 'ping',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toBe('refused [redacted]')
  expect(result.listedTools).toEqual(['ping'])
})

test('a reply line with multi-byte text is not lost to the line after it', () => {
  const first = { jsonrpc: '2.0', id: 1, result: { text: 'refusé — 拒否' } }
  const second = { jsonrpc: '2.0', method: 'notifications/message' }
  const stdout = Buffer.from(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
  expect(decodeMessages(stdout)).toEqual([first, second])
})

test('a Content-Length frame is still decoded whole, even when its body spans lines', () => {
  const framed = { jsonrpc: '2.0', id: 1, result: { text: 'refusé' } }
  const body = Buffer.from(JSON.stringify(framed, null, 2))
  const after = { jsonrpc: '2.0', method: 'notifications/message' }
  const stdout = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
    Buffer.from(`${JSON.stringify(after)}\n`),
  ])
  expect(decodeMessages(stdout)).toEqual([framed, after])
})
