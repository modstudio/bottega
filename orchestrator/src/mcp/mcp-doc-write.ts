// concern: mcp-doc-write
/** Knows which document writes the worker-facing MCP surface may expose. */
export type McpDocWriteTool = 'set_doc' | 'remove_doc' | 'consume_doc'

export function decideMcpDocWrite(
  tool: McpDocWriteTool,
  scope: string,
  isOrchWorker: boolean,
): string | null {
  if (scope !== 'canon') return null
  if (tool === 'consume_doc') {
    return 'refusing MCP consume_doc for canon: canon rows cannot be consumed'
  }
  if (!isOrchWorker) return null

  const command = tool === 'set_doc' ? 'set' : 'rm'
  return (
    `refusing MCP ${tool} for canon: this process is an orch worker; change canon from an ` +
    `architect session with ${tool} (or \`orch doc ${command} --scope canon\`) with ` +
    'expected_revision, then run `orch canon hydrate`'
  )
}
