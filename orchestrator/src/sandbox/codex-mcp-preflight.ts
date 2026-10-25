// concern: codex-mcp-preflight
/** Runs the Codex-only catalogue preflight over already-granted MCP servers. */
import { launchFailureReason, listMcpToolPages } from '../mcp/mcp-tool-list.ts'
import type { CodexMcpCatalogue, CodexMcpScope } from './codex-mcp-scope.ts'

export async function preflightCodexMcpCatalogues(
  scope: CodexMcpScope | null,
  env: Record<string, string>,
): Promise<CodexMcpCatalogue[]> {
  if (!scope) return []
  return Promise.all(
    Object.entries(scope.servers).map(async ([server, launch]) => {
      try {
        return { server, pages: await listMcpToolPages(launch, env) }
      } catch (error) {
        return { server, error: launchFailureReason(error) }
      }
    }),
  )
}
