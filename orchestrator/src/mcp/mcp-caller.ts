// concern: mcp-caller
/** Gives each MCP tool invocation its own hosted-record caller scope. */

import type { McpServer } from '@modelcontextprotocol/server'
import { withRecordCaller } from '../record/record-caller.ts'

export function scopeMcpToolCallers(
  server: McpServer,
  onRegister: (name: string) => void = () => undefined,
): void {
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: object,
    handler: (...args: never[]) => Promise<unknown>,
  ) => unknown
  server.registerTool = ((
    name: string,
    config: object,
    handler: (...args: never[]) => Promise<unknown>,
  ) => {
    onRegister(name)
    return registerTool(name, config, (...args: never[]) =>
      withRecordCaller(`mcp:${name}`, () => handler(...args)),
    )
  }) as typeof server.registerTool
}
