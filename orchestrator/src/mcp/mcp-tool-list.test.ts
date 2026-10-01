import { expect, test } from 'bun:test'
import { McpToolCallError, unwrapMcpToolResult } from './mcp-tool-list.ts'

test('a tool error keeps its structured content', () => {
  const structuredContent = {
    success: false,
    error: 'Task not found: STO-12',
    code: 'NOT_FOUND',
  }

  try {
    unwrapMcpToolResult(
      {
        isError: true,
        structuredContent,
        content: [{ type: 'text', text: structuredContent.error }],
      },
      'task.getByKey',
    )
    throw new Error('expected unwrapMcpToolResult to throw')
  } catch (cause) {
    expect(cause).toBeInstanceOf(McpToolCallError)
    expect((cause as McpToolCallError).structuredContent).toEqual(structuredContent)
  }
})
