// concern: codex-mcp-preflight
/** Runs the Codex-only catalogue preflight over already-granted MCP servers. */
import { listMcpToolPages } from '../mcp/mcp-tool-list.ts'
import type { CodexMcpCatalogue, CodexMcpScope } from './codex-mcp-scope.ts'

function failureReason(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .replaceAll(/\s+/g, ' ')
    .trim()
}

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
        return { server, error: failureReason(error) }
      }
    }),
  )
}
