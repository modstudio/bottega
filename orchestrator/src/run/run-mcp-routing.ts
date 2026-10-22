// concern: run MCP routing
/** Resolves route facts and enforces native attachment before vendor launch. */
import { predictNativeMcpAttachment } from '../mcp/mcp-compatibility.ts'
import { type McpRequest, requestedMcpMode, requiredMcpServer } from '../mcp/mcp-preflight.ts'
import type { TransportName } from '../transport/transport.ts'
import { recordRunStartupFailure } from './run-startup-failure.ts'

export function routeMcp(
  request: McpRequest | undefined,
  cwd: string,
  project: string | null,
  opts: { transport?: TransportName },
  transport: TransportName,
) {
  const pinned = opts.transport !== undefined || Boolean(process.env.ORCH_TRANSPORT)
  return requiredMcpServer(request, cwd, project ?? undefined, pinned ? transport : undefined)
}

export function mcpForRun(
  agent: { name: string; harness?: string; caps: { mcp: boolean } },
  transport: TransportName,
  request: McpRequest | undefined,
  reserveId: string | undefined,
): boolean {
  const mode = requestedMcpMode(request)
  if (!mode) return agent.caps.mcp
  const prediction = predictNativeMcpAttachment({
    name: agent.name,
    harness: agent.harness,
    transport,
  })
  if (mode !== 'require' || prediction.confirmable) {
    return prediction.confirmable
  }
  recordRunStartupFailure(reserveId, prediction.reason!)
  throw new Error(prediction.reason!)
}
