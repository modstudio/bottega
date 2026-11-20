// concern: codex-sandbox
/**
 * Codex native sandbox ruling and the argv switch that chooses
 * --approve-for-me versus -s. Dispatch and the confinement report call these;
 * they must not probe the vendor.
 */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type CodexSandboxRuling = {
  sandbox: 'read-only' | 'workspace-write'
  workspaceWriteNetworkAccess: boolean
}

export type CodexPermissionFilesystem = {
  denyRead: readonly string[]
  allowRead: readonly string[]
}

export const CODEX_PERMISSION_PROFILE = PLATFORM_SLUG

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Render the native Codex permission profile from the shared read policy and current write roots. */
export function codexPermissionProfileArgs(input: {
  filesystem: CodexPermissionFilesystem
  writableRoots: readonly string[]
  network: boolean
}): string[] {
  const permissions = new Map<string, 'read' | 'write' | 'deny'>([[':root', 'read']])
  for (const path of input.filesystem.allowRead) permissions.set(path, 'read')
  for (const path of input.writableRoots) permissions.set(path, 'write')
  // Codex resolves a more specific entry first and deny wins at equal specificity.
  for (const path of input.filesystem.denyRead) permissions.set(path, 'deny')
  const filesystem = [...permissions]
    .map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`)
    .join(',')
  return [
    '-c',
    `default_permissions=${tomlString(CODEX_PERMISSION_PROFILE)}`,
    '-c',
    `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={${filesystem}}`,
    ...(input.network
      ? ['-c', `permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=true`]
      : []),
  ]
}

/** Decide Codex's native sandbox separately from the srt/host outer seam. */
export function decideCodexSandbox(): CodexSandboxRuling {
  return {
    sandbox: 'workspace-write',
    workspaceWriteNetworkAccess: false,
  }
}

/** Writable roots implied by the native Codex sandbox ruling and launch facts. */
export function codexWritableRoots(
  sandbox: CodexSandboxRuling['sandbox'] | 'danger-full-access',
  cwd: string,
  extraRoots: string[],
  tmpDir: string | undefined,
): string[] | null {
  if (sandbox !== 'workspace-write') return null
  return [...new Set([cwd, ...extraRoots, '/tmp', tmpDir ?? '/tmp'])]
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
