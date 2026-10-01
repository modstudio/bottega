export type CodexSandboxFacts = {
  readsRepo: boolean
}

export type CodexSandboxRuling = {
  sandbox: 'read-only' | 'workspace-write'
  workspaceWriteNetworkAccess: boolean
}

/** Decide Codex's native sandbox separately from the srt/host outer seam. */
export function decideCodexSandbox(facts: CodexSandboxFacts): CodexSandboxRuling {
  return {
    sandbox: facts.readsRepo ? 'workspace-write' : 'read-only',
    workspaceWriteNetworkAccess: false,
  }
}
