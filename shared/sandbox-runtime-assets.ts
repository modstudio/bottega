const PACKAGE_ROOT = 'orchestrator/node_modules/@anthropic-ai/sandbox-runtime'

export type SandboxRuntimePayload = {
  packagePath: string
  destination: string
  mode: 0o644 | 0o755
}

export type SandboxRuntimeAssets = {
  javaAgent: SandboxRuntimePayload
  seccompApply?: SandboxRuntimePayload
  srtWin?: SandboxRuntimePayload
}

function payload(destination: string, mode: 0o644 | 0o755): SandboxRuntimePayload {
  return { packagePath: `${PACKAGE_ROOT}/${destination}`, destination, mode }
}

/** The single definition of payload roles needed by a binary's target platform. */
export function sandboxRuntimeAssets(
  platform: NodeJS.Platform,
  arch: string,
): SandboxRuntimeAssets {
  return {
    javaAgent: payload('vendor/java-proxy-agent/srt-proxy-agent.jar', 0o644),
    ...(platform === 'linux' && (arch === 'x64' || arch === 'arm64')
      ? { seccompApply: payload(`vendor/seccomp/${arch}/apply-seccomp`, 0o755) }
      : {}),
    ...(platform === 'win32' && (arch === 'x64' || arch === 'arm64')
      ? { srtWin: payload(`vendor/srt-win/${arch}/srt-win.exe`, 0o755) }
      : {}),
  }
}

/** Flat build input derived from the named host payload descriptions. */
export function sandboxRuntimePayloadPaths(platform: NodeJS.Platform, arch: string): string[] {
  return Object.values(sandboxRuntimeAssets(platform, arch)).map((asset) => asset.packagePath)
}
