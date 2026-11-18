// concern: mcp-caller
/** Gives each MCP tool invocation its own hosted-record caller scope. */

import type { McpServer } from '@modelcontextprotocol/server'
import { withRecordCaller } from '../../../shared/record-caller.ts'

type ToolHandler = (...args: never[]) => Promise<unknown>

export function wrapMcpToolHandlers(
  server: McpServer,
  wrap: (name: string, handler: ToolHandler) => ToolHandler,
  onRegister: (name: string) => void = () => undefined,
): void {
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: object,
    handler: ToolHandler,
  ) => unknown
  server.registerTool = ((name: string, config: object, handler: ToolHandler) => {
    onRegister(name)
    return registerTool(name, config, wrap(name, handler))
  }) as typeof server.registerTool
}

export function scopeMcpToolCallers(
  server: McpServer,
  onRegister: (name: string) => void = () => undefined,
): void {
  wrapMcpToolHandlers(
    server,
    (name, handler) =>
      (...args) =>
        withRecordCaller(`mcp:${name}`, () => handler(...args)),
    onRegister,
  )
}
