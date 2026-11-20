// concern: Codex permission-profile launch adapter

import type { CodexMcpScope } from '../sandbox/codex-mcp-scope.ts'
import { codexWritableRoots } from '../sandbox/codex-sandbox.ts'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import type { ArgvOpts } from '../transport/transport.ts'

function codexTransportMcpScope(scope: CodexMcpScope | null) {
  return {
    projectServers: scope?.servers,
    withheldProjectServers: scope?.withheld.map((server) => server.name),
  }
}

export function codexTransportScope(
  scope: CodexMcpScope | null,
  input: Parameters<typeof codexPermissionLaunchProfile>[0],
) {
  return {
    ...codexTransportMcpScope(scope),
    codexPermissionProfile: codexPermissionLaunchProfile(input),
  }
}

/** Translate the shared read profile and current Codex write roots at the launch edge. */
function codexPermissionLaunchProfile(input: {
  name: string
  sandboxSelection: { codexProfile?: SandboxRuntimeConfig }
  codexSandbox: { sandbox: 'read-only' | 'workspace-write' }
  cwd: string
  writableRoots: string[]
  runTemp: { directory: string | undefined }
}): ArgvOpts['codexPermissionProfile'] {
  const profile = input.sandboxSelection.codexProfile
  if (input.name !== 'codex' || !profile) return undefined
  return {
    filesystem: {
      denyRead: profile.filesystem.denyRead,
      allowRead: profile.filesystem.allowWithinDeny,
    },
    writableRoots:
      codexWritableRoots(
        input.codexSandbox.sandbox,
        input.cwd,
        input.writableRoots,
        input.runTemp.directory,
        input.repoJob,
      ) ?? [],
  }
}
