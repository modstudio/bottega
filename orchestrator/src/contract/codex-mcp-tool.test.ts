// Tests codex-mcp-tool.ts: code-mode identifiers and Codex-only contract text.
import { expect, test } from 'bun:test'
import { bindCodexMcpToolInstruction, codexMcpToolIdentifier } from './codex-mcp-tool.ts'
import { workerPreamble } from './contract.ts'

test('normalizes MCP server and tool names to Codex code-mode identifiers', () => {
  expect(codexMcpToolIdentifier('bottega-ask', 'run_tests')).toBe('mcp__bottega_ask__run_tests')
  expect(codexMcpToolIdentifier('bottega-x', 'abandon_workflow')).toBe(
    'mcp__bottega_x__abandon_workflow',
  )
})

test('adds the nested run_tests call only to a Codex-bound worker prompt', () => {
  const preamble = workerPreamble('implement')
  expect(bindCodexMcpToolInstruction(preamble, 'codex')).toContain(
    'tools.mcp__bottega_ask__run_tests',
  )
  expect(bindCodexMcpToolInstruction(preamble, 'grok')).not.toContain(
    'tools.mcp__bottega_ask__run_tests',
  )
})
