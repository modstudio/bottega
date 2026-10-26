import { expect, test } from 'bun:test'
import { resolveProjectMcpCommand } from './mcp-command.ts'

test('resolves only project-relative MCP command paths against the cwd', () => {
  expect(resolveProjectMcpCommand('scripts/mcp/boost', '/project/tree')).toBe(
    '/project/tree/scripts/mcp/boost',
  )
  expect(resolveProjectMcpCommand('bun', '/project/tree')).toBe('bun')
  expect(resolveProjectMcpCommand('/opt/project/bin/server', '/project/tree')).toBe(
    '/opt/project/bin/server',
  )
})
