import { describe, expect, test } from 'bun:test'
import { decideMcpDocWrite, type McpDocWriteTool } from './mcp-doc-write.ts'

describe('MCP document writes', () => {
  for (const tool of ['set_doc', 'remove_doc'] as McpDocWriteTool[]) {
    test(`${tool} worker refuses canon and names the architect workflow`, () => {
      const refusal = decideMcpDocWrite(tool, 'canon', true)
      expect(refusal).toContain(`refusing MCP ${tool} for canon`)
      expect(refusal).toContain('this process is an orch worker')
      expect(refusal).toContain(tool)
      expect(refusal).toContain(`orch doc ${tool === 'set_doc' ? 'set' : 'rm'} --scope canon`)
      expect(refusal).toContain('architect session')
      expect(refusal).toContain('expected_revision')
      expect(refusal).toContain('orch canon hydrate')
    })

    test(`${tool} allows canon for a non-worker`, () => {
      expect(decideMcpDocWrite(tool, 'canon', false)).toBeNull()
    })

    test.each(['project', 'global', 'resume'])(`${tool} allows %s scope`, (scope) => {
      expect(decideMcpDocWrite(tool, scope, true)).toBeNull()
      expect(decideMcpDocWrite(tool, scope, false)).toBeNull()
    })
  }

  test.each([true, false])('consume_doc refuses canon when worker is %s', (worker) => {
    expect(decideMcpDocWrite('consume_doc', 'canon', worker)).toBe(
      'refusing MCP consume_doc for canon: canon rows cannot be consumed',
    )
  })

  test.each(['project', 'global', 'resume'])('consume_doc allows %s scope', (scope) => {
    expect(decideMcpDocWrite('consume_doc', scope, true)).toBeNull()
    expect(decideMcpDocWrite('consume_doc', scope, false)).toBeNull()
  })
})
