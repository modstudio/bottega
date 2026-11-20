// concern: pure host-versus-srt sandbox selection

export type RunSandbox = 'host' | 'srt'

export function isReadonlySandboxCandidate(input: {
  agent: string
  readsRepo: boolean
  writesRepo: boolean
}): boolean {
  return input.agent !== 'codex' && !input.writesRepo
}

function isSandboxCandidate(input: {
  agent: string
  readsRepo: boolean
  writesRepo: boolean
  writingAcp?: boolean
}): boolean {
  return isReadonlySandboxCandidate(input) || (input.writesRepo && input.writingAcp === true)
}

export type ReadonlySandboxKind = {
  sandbox: RunSandbox
  reason: string | null
  missingRoot: boolean
}

export function readonlySandboxWriteRoots(input: {
  sharedReader?: boolean
  runtimeDir: string
  scratchDir?: string
}): string[] | undefined {
  if (!input.sharedReader) return undefined
  return [input.runtimeDir, ...(input.scratchDir ? [input.scratchDir] : [])]
}

/** Host-versus-srt decision dispatch uses before it builds an SRT profile. */
export function selectReadonlySandboxKind(input: {
  agent: string
  readsRepo: boolean
  writesRepo: boolean
  worktreePresent: boolean
  projectPresent: boolean
  override?: string
  mcp?: boolean
  writingAcp?: boolean
}): ReadonlySandboxKind {
  if (!isSandboxCandidate(input)) return { sandbox: 'host', reason: null, missingRoot: false }
  if (input.writingAcp) {
    if (!input.worktreePresent || !input.projectPresent)
      return { sandbox: 'srt', reason: null, missingRoot: true }
    if (input.override === 'host')
      throw new Error('writing ACP sandbox refusal: BOTTEGA_SANDBOX=host cannot bypass srt')
    return { sandbox: 'srt', reason: null, missingRoot: false }
  }
  // Preserve the repository seam exactly: an unregistered or not-yet-cut
  // readonly checkout was already a host run. No-repo jobs have no such
  // fallback because their isolate is the boundary this selector must build.
  if (input.readsRepo && (!input.worktreePresent || !input.projectPresent))
    return { sandbox: 'host', reason: null, missingRoot: false }
  if (input.override === 'host') {
    return {
      sandbox: 'host',
      reason: input.readsRepo
        ? 'BOTTEGA_SANDBOX=host'
        : 'BOTTEGA_SANDBOX=host skipped the no-repo isolate sandbox; run is unconfined',
      missingRoot: false,
    }
  }
  if (input.mcp) {
    return {
      sandbox: 'host',
      reason: 'MCP was requested; srt blocks MCP transports; run is unconfined',
      missingRoot: false,
    }
  }
  if (!input.worktreePresent) return { sandbox: 'srt', reason: null, missingRoot: true }
  return { sandbox: 'srt', reason: null, missingRoot: false }
}
