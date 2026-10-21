// concern: run claim result contract
import type { McpConnection } from '../mcp/mcp-preflight.ts'
import type { KeepTreeExemption } from '../worktree/keep-tree-hold.ts'
import type { prepareWorkerMcpConfig } from '../worktree/worktree-mcp.ts'
import type { Changes } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'

export type ClaimResult = {
  promptPath: string
  outputPath: string
  originalSchemaPath: string | undefined
  textReplyContract: boolean
  schemaPath: string | undefined
  started: number
  launchKey: string | null
  runToken: string
  claim: { id: string; recordId: string; number: number }
  keepTree: KeepTreeExemption | undefined
  scratchDir: string
  worktree: Worktree | null
  changes: Changes | null
  isolatedCwd: string | null
  removeIsolatedCwd: (() => void) | null
  provisionedMcpConfig: ReturnType<typeof prepareWorkerMcpConfig> | null
  retargetDiagnostic: string | null
  mcpSetupHeader: string | null
  mcpTrustGranted: boolean
  grokMcpEnvironment: Record<string, string>
  sandboxRunDir: string
  sandboxRunDirExisted: boolean
  cwd: string
  prompt: string
  mcpConnection: McpConnection | null
  usingMcp: boolean
}
