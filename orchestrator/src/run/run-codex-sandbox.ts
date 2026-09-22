export type CodexSandboxFacts = {
  agentIsCodex: boolean
  readsRepo: boolean
  writesRepo: boolean
  readonlyDocker: boolean
}

export type CodexSandboxRuling = {
  sandbox: 'read-only' | 'workspace-write'
  workspaceWriteNetworkAccess: boolean
}

/** Decide Codex's native sandbox separately from the srt/host outer seam. */
export function decideCodexSandbox(facts: CodexSandboxFacts): CodexSandboxRuling {
  return {
    sandbox: facts.readsRepo ? 'workspace-write' : 'read-only',
    workspaceWriteNetworkAccess:
      facts.agentIsCodex && facts.readsRepo && !facts.writesRepo && facts.readonlyDocker,
  }
}
