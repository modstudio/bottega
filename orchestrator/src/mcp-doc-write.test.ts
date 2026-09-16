import { describe, expect, test } from 'bun:test'
import { decideMcpDocWrite, type McpDocWriteTool } from './mcp-doc-write.ts'

describe('MCP document writes', () => {
  for (const tool of ['set_doc', 'consume_doc'] as McpDocWriteTool[]) {
    test(`${tool} refuses canon and names the architect workflow`, () => {
      const refusal = decideMcpDocWrite(tool, 'canon')
      expect(refusal).toContain(`refusing MCP ${tool} for canon`)
      expect(refusal).toContain('orch doc set --scope canon')
      expect(refusal).toContain('architect session')
      expect(refusal).toContain('orch canon hydrate')
    })

    test.each(['project', 'global', 'resume'])(`${tool} allows %s scope`, (scope) => {
      expect(decideMcpDocWrite(tool, scope)).toBeNull()
    })
  }
})
