import { expect, test } from 'bun:test'
import { mcpForRun } from './run-mcp-routing.ts'

test('required MCP uses native attachment prediction instead of the probe flag', () => {
  expect(mcpForRun({ name: 'codex', caps: { mcp: false } }, 'cli', 'require', undefined)).toBe(true)
})

test('required MCP refuses an unconfirmable native attachment before launch', () => {
  expect(() =>
    mcpForRun(
      { name: 'deepseek', harness: 'goose', caps: { mcp: true } },
      'acp',
      'require',
      undefined,
    ),
  ).toThrow(
    'native project MCP attachment is unconfirmable: ACP session launch does not attach project servers',
  )
})

test('preferred MCP degrades and an implicit writer still uses the probe capability', () => {
  const agent = { name: 'deepseek', harness: 'goose', caps: { mcp: true } }
  expect(mcpForRun(agent, 'acp', 'prefer', undefined)).toBe(false)
  expect(mcpForRun(agent, 'acp', undefined, undefined)).toBe(true)
})
