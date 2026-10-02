export type CodexSandboxRuling = {
  sandbox: 'read-only' | 'workspace-write'
  workspaceWriteNetworkAccess: boolean
}

/** Decide Codex's native sandbox separately from the srt/host outer seam. */
export function decideCodexSandbox(): CodexSandboxRuling {
  return {
    sandbox: 'workspace-write',
    workspaceWriteNetworkAccess: false,
  }
}
