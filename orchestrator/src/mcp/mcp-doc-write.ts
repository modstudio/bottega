// concern: mcp-doc-write
/** Knows which document writes the worker-facing MCP surface may expose. */
export type McpDocWriteTool = 'set_doc' | 'remove_doc' | 'consume_doc'

export function decideMcpDocWrite(
  tool: McpDocWriteTool,
  scope: string,
  isOrchWorker: boolean,
): string | null {
  if (scope !== 'canon') return null
  if (tool !== 'consume_doc' && !isOrchWorker) return null
  return (
    `refusing MCP ${tool} for canon: canon is edited with ` +
    '`orch doc set --scope canon` from an architect session, then hydrated with `orch canon hydrate`'
  )
}
