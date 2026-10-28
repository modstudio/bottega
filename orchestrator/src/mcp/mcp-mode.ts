// concern: mcp-mode
/** MCP request modes accepted by the run CLI. */
export const MCP_MODE_VALUES = ['require', 'prefer'] as const

export type McpMode = (typeof MCP_MODE_VALUES)[number]

export function isMcpMode(value: string | undefined): value is McpMode {
  return value !== undefined && MCP_MODE_VALUES.some((mode) => mode === value)
}
