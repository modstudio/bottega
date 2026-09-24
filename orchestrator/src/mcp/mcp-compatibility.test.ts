import { describe, expect, test } from 'bun:test'
import { decideMcpCompatibility, mcpGrammarMismatchRefusal } from './mcp-compatibility.ts'

const grok = '^[A-Za-z0-9_-]{1,64}$'

describe('MCP tool-name compatibility', () => {
  test('dotted names are incompatible with the grok grammar', () => {
    expect(decideMcpCompatibility(['workflow.list', 'task.get'], grok).verdict).toBe('incompatible')
  })

  test('an absent grammar translates dotted names', () => {
    expect(decideMcpCompatibility(['workflow.list'], undefined).verdict).toBe('compatible')
  })

  test('a mixed catalogue is partial', () => {
    expect(decideMcpCompatibility(['workflow.list', 'workflow_list'], grok).verdict).toBe('partial')
  })

  test('an absent listing is unknown', () => {
    expect(decideMcpCompatibility(undefined, grok)).toEqual({
      listed: null,
      admitted: null,
      verdict: 'unknown',
    })
  })

  test('the pre-launch backstop names the mismatch and re-dispatch remedy', () => {
    expect(
      mcpGrammarMismatchRefusal({
        server: 'stopal',
        listedTools: ['workflow.list', 'task.get'],
        pattern: grok,
      }),
    ).toBe(
      "MCP server 'stopal' tool-name grammar is incompatible: 0/2 admitted by ^[A-Za-z0-9_-]{1,64}$; re-dispatch to route to a compatible agent",
    )
  })
})
