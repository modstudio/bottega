import { expect, test } from 'bun:test'
import { disabledProjectMcpServers } from './mcp-probe.ts'

test('computes the complement only for declared worker MCP scope', () => {
  const names = ['orch', 'starship', 'stopal']
  expect(disabledProjectMcpServers(names, undefined)).toEqual([])
  expect(disabledProjectMcpServers(names, [])).toEqual(names)
  expect(disabledProjectMcpServers(names, ['starship'])).toEqual(['orch', 'stopal'])
})
