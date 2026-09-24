import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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

test('a successful orch tool probe leaves worker attachment unverified', () => {
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
    error: 'orch probe ok: task_list; worker attachment unverified',
  })
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
