// concern: Codex permission-profile launch adapter

import type { CodexMcpScope } from '../sandbox/codex-mcp-scope.ts'
import { codexPermissionLaunchProfileInput } from '../sandbox/codex-permission-profile-adapter.ts'
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
  writesJob: boolean
  sandboxSelection: { codexProfile?: SandboxRuntimeConfig }
  codexSandbox: { sandbox: 'read-only' | 'workspace-write' }
  cwd: string
  writableRoots: string[]
  runTemp: { directory: string | undefined }
}): ArgvOpts['codexPermissionProfile'] {
  const profile = input.sandboxSelection.codexProfile
  if (input.name !== 'codex' || !profile) return undefined
  return codexPermissionLaunchProfileInput({
    profile,
    sandbox: input.codexSandbox.sandbox,
    cwd: input.cwd,
    writableRoots: input.writableRoots,
    tempDir: input.runTemp.directory,
    writesRepository: input.writesJob,
  })
}
