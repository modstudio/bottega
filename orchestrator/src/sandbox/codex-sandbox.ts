// concern: codex-sandbox
/**
 * Codex native sandbox ruling and the argv switch that chooses
 * --approve-for-me versus -s. Dispatch and the confinement report call these;
 * they must not probe the vendor.
 */

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

/**
 * Whether a Codex launch uses --approve-for-me instead of -s. Mutually
 * exclusive with --sandbox; implies workspace-write. Does not select
 * danger-full-access and does not turn native network on.
 */
export function codexLaunchUsesApproveForMe(input: {
  mcp: boolean | undefined
  sandbox: CodexSandboxRuling['sandbox'] | 'danger-full-access'
  repository: boolean | undefined
}): boolean {
  return Boolean(input.mcp || (input.repository && input.sandbox === 'workspace-write'))
}
