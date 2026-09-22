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

export function codexAcpReadonlyDockerRefusal(input: {
  agentIsCodex: boolean
  transport: string
  readsRepo: boolean
  writesRepo: boolean
  readonlyDocker: boolean
  projectName: string
}): string | null {
  if (
    input.agentIsCodex &&
    input.transport === 'acp' &&
    input.readsRepo &&
    !input.writesRepo &&
    input.readonlyDocker
  ) {
    return `project ${input.projectName} declares worktree.readonly_docker, which needs Codex's command sandbox; run with --transport cli`
  }
  return null
}

/** Decide Codex's native sandbox separately from the srt/host outer seam. */
export function decideCodexSandbox(facts: CodexSandboxFacts): CodexSandboxRuling {
  return {
    sandbox: facts.readsRepo ? 'workspace-write' : 'read-only',
    workspaceWriteNetworkAccess:
      facts.agentIsCodex && facts.readsRepo && !facts.writesRepo && facts.readonlyDocker,
  }
}
