// concern: mcp-caller
/** Scopes hosted-record callers and, when requested by the docs MCP, request sessions. */

import type { McpServer } from '@modelcontextprotocol/server'
import { isWorkerEnvironment } from '../../../shared/caller-classification.ts'
import { withRecordCaller } from '../../../shared/record-caller.ts'
import {
  type RequestSessionPublicationLookup,
  resolveRequestSession,
  withRequestSession,
} from '../../../shared/request-session.ts'

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
  options: {
    onRegister?: (name: string) => void
    requestSession?: () => RequestSessionPublicationLookup
  } = {},
): void {
  wrapMcpToolHandlers(
    server,
    (name, handler) =>
      (...args) => {
        const invoke = () => withRecordCaller(`mcp:${name}`, () => handler(...args))
        if (!options.requestSession || isWorkerEnvironment(process.env)) return invoke()
        const context = args[1] as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined
        const resolved = resolveRequestSession({
          meta: context?.mcpReq?._meta,
          published: options.requestSession(),
        })
        if (resolved.kind === 'refusal') throw new Error(resolved.reason)
        return withRequestSession(resolved.value, invoke)
      },
    options.onRegister,
  )
}
