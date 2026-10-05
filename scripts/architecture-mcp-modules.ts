// concern: architecture-manifest
/** The orchestrator MCP surface's module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type McpModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): McpModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const mcpModules: McpModule[] = [
  module('orchestrator/src/mcp/mcp-board-tools.ts', [
    '@modelcontextprotocol/server',
    'zod',
    '../board/board-policy.ts',
    '../board/board-service.ts',
    '../board/board-suggestions.ts',
    '../board/board-thread-service.ts',
    './mcp-board-claim-tools.ts',
  ]),
  module('orchestrator/src/mcp/mcp-board-claim-tools.ts', [
    '@modelcontextprotocol/server',
    'zod',
    '../board/board-claim-service.ts',
  ]),
  module('orchestrator/src/mcp/hub-notes.ts', [
    'zod',
    '../../../shared/self-spawn.ts',
    '../ask/worker-auth.ts',
    '../database/db.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/mcp/mcp-operator-tools.ts', [
    '@modelcontextprotocol/sdk/server/mcp.js',
    'zod',
    '../../../shared/docs.ts',
    '../../../shared/orch-contract.ts',
    '../doc/docs.ts',
    '../operator/operator-waiting.ts',
    '../run/ruling-file.ts',
    '../run/ruling-overturn.ts',
    '../run/run-answer.ts',
    '../run/run-inbox.ts',
    '../run/run-message-commands.ts',
    './hub-notes.ts',
  ]),
  module('orchestrator/src/mcp/mcp-tool-list.ts', [
    '@modelcontextprotocol/sdk/client/index.js',
    '@modelcontextprotocol/sdk/client/stdio.js',
    '@modelcontextprotocol/sdk/client/streamableHttp.js',
  ]),
  module('orchestrator/src/mcp/mcp-compatibility.ts', []),
  module('orchestrator/src/mcp/mcp-doc-write.ts', ['../worker-store-write.ts']),
  module('orchestrator/src/mcp/mcp-doc-tools.ts', [
    '@modelcontextprotocol/sdk/server/mcp.js',
    'zod',
    '../canon/canon.ts',
    '../doc/doc-canon-tree.ts',
    '../doc/docs.ts',
    '../worker-store-write.ts',
    './mcp-doc-write.ts',
  ]),
  module('orchestrator/src/mcp/mcp-search-tools.ts', [
    '@modelcontextprotocol/sdk/server/mcp.js',
    'zod',
    '../code/code-search.ts',
    '../doc/doc-search.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/mcp/mcp-prompts.ts', [
    '@modelcontextprotocol/sdk/server/mcp.js',
    'zod',
    '../project/projects.ts',
    '../workflow/autonomy.ts',
    '../workflow/autonomy-scopes.ts',
    '../workflow/workflow-render.ts',
    '../workflow/workflow-cursor.ts',
    '../workflow/workflow-cursor-selection.ts',
    '../workflow/workflows.ts',
  ]),
]
