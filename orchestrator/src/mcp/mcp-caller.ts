// concern: mcp-caller
/** Gives each MCP tool invocation its own hosted-record caller scope. */

import type { McpServer } from '@modelcontextprotocol/server'
import { WORKER_ENVIRONMENT_MARKERS } from '../../../shared/caller-classification.ts'
import { withRecordCaller } from '../../../shared/record-caller.ts'
import { resolveRequestSession, withRequestSession } from '../../../shared/request-session.ts'

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
  readPublishedSession?: () => string | null,
): void {
  wrapMcpToolHandlers(
    server,
    (name, handler) =>
      (...args) => {
        const invoke = () => withRecordCaller(`mcp:${name}`, () => handler(...args))
        if (!readPublishedSession) return invoke()
        if (WORKER_ENVIRONMENT_MARKERS.some((marker) => Boolean(process.env[marker]?.trim())))
          return invoke()
        const context = args[1] as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined
        const resolved = resolveRequestSession({
          meta: context?.mcpReq?._meta,
          published: readPublishedSession(),
        })
        if (resolved.kind === 'refusal') throw new Error(resolved.reason)
        return withRequestSession(resolved.value, invoke)
      },
    onRegister,
  )
}
