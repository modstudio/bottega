export type CodexSandboxFacts = {
  readsRepo: boolean
}

export type CodexSandboxRuling = {
  sandbox: 'read-only' | 'workspace-write'
  workspaceWriteNetworkAccess: boolean
}

/** Decide Codex's native sandbox separately from the srt/host outer seam. */
export function decideCodexSandbox(facts: CodexSandboxFacts): CodexSandboxRuling {
  if (facts.readsRepo) {
    return {
      sandbox: 'workspace-write',
      workspaceWriteNetworkAccess: false,
    }
  }
  return {
    sandbox: 'workspace-write',
    workspaceWriteNetworkAccess: false,
  }
}
