import { expect, test } from 'bun:test'
import { disabledProjectMcpServers, mcpCallEvidence } from './mcp-probe.ts'

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
