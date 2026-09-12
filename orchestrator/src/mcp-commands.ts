// concern: mcp
/** Owns MCP server entry and configuration presentation. Must not know CLI grammar. */
import { serveDocsMcp } from './mcp.ts'

export async function mcpCommand(config: boolean, binary: string, presentation: { log(value: string): void }): Promise<void> {
  if (config) presentation.log(JSON.stringify({ mcpServers: { orch: { command: binary, args: ['mcp'] } } }, null, 2))
  else await serveDocsMcp()
}
