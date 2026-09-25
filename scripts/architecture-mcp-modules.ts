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
  module('orchestrator/src/mcp/hub-notes.ts', [
    'zod',
    '../../../shared/install-root.ts',
    '../ask/ask.ts',
    '../database/db.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/mcp/mcp-operator-tools.ts', [
    '@modelcontextprotocol/sdk/server/mcp.js',
    'zod',
    '../../../shared/orch-contract.ts',
    '../operator/operator-waiting.ts',
    '../run/ruling-overturn.ts',
    '../run/run-answer.ts',
    '../run/run-inbox.ts',
    '../run/run-message-commands.ts',
  ]),
  module('orchestrator/src/mcp/mcp-tool-list.ts', [
    '@modelcontextprotocol/sdk/client/index.js',
    '@modelcontextprotocol/sdk/client/stdio.js',
    '@modelcontextprotocol/sdk/client/streamableHttp.js',
  ]),
  module('orchestrator/src/mcp/mcp-compatibility.ts', []),
  module('orchestrator/src/mcp/mcp-doc-write.ts', []),
  module('orchestrator/src/mcp/mcp-doc-tools.ts', [
    '@modelcontextprotocol/sdk/server/mcp.js',
    'zod',
    '../canon/canon.ts',
    '../doc/docs.ts',
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
    '../workflow/workflows.ts',
  ]),
]
