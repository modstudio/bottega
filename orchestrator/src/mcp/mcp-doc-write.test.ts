import { describe, expect, test } from 'bun:test'
import { decideMcpDocWrite, type McpDocWriteTool } from './mcp-doc-write.ts'

describe('MCP document writes', () => {
  for (const tool of ['set_doc', 'remove_doc'] as McpDocWriteTool[]) {
    test.each(['canon', 'project', 'global', 'resume'])(
      `${tool} allows %s scope at the MCP policy layer`,
      (scope) => {
        expect(decideMcpDocWrite(tool, scope)).toBeNull()
      },
    )
  }

  test('consume_doc refuses canon because canon rows cannot be consumed', () => {
    expect(decideMcpDocWrite('consume_doc', 'canon')).toBe(
      'refusing MCP consume_doc for canon: canon rows cannot be consumed',
    )
  })

  test.each(['project', 'global', 'resume'])(
    'consume_doc allows %s scope for a non-worker',
    (scope) => {
      expect(decideMcpDocWrite('consume_doc', scope)).toBeNull()
    },
  )
})
