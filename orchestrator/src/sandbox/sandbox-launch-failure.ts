// concern: pure classification of sandbox launch failures; must not inspect the host.

export type SandboxLaunchFailureFacts = {
  platform: NodeJS.Platform
  sandboxKind: 'srt' | 'host'
  stderr: string
  launchError: string
}

export type SandboxReadinessRefusal = {
  kind: 'sandbox-readiness'
}

/** Identify only Linux srt failures that host readiness can remedy. */
export function classifySandboxLaunchFailure(
  facts: SandboxLaunchFailureFacts,
): SandboxReadinessRefusal | null {
  if (facts.platform !== 'linux' || facts.sandboxKind !== 'srt') return null
  const text = `${facts.stderr}\n${facts.launchError}`
  return /RTM_NEWADDR|setting up uid map:\s*Permission denied|Sandbox dependencies not available|bubblewrap \(bwrap\) not installed/i.test(
    text,
  )
    ? { kind: 'sandbox-readiness' }
    : null
}
