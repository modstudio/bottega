import { expect, test } from 'bun:test'
import { launchFailure, McpToolCallError, unwrapMcpToolResult } from './mcp-tool-list.ts'

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

test('a probe keeps the child diagnostic but withholds a secret-shaped stderr line', () => {
  const failure = launchFailure(
    new Error('Connection closed'),
    'starting starship upstream\nBOTTEGA_RUN_TOKEN=abc123\nlistening on the socket',
  )

  // The tail reaches a refusal, the stored run record and the Codex setup
  // header, so the credential-shaped line stays out while the rest survives.
  expect(failure.message).not.toContain('abc123')
  expect(failure.message).toContain('[withheld line: assignment]')
  expect(failure.message).toContain('starting starship upstream')
  expect(failure.message).toContain('listening on the socket')
  expect(failure.message).toContain('Connection closed')
  // One line: this text is a run's error and mcp_error, and a newline would
  // move the rest of the tail out of the reported message.
  expect(failure.message).not.toContain('\n')
})
