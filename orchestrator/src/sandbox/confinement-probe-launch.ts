// concern: shared confinement-probe launch and process-error formatting.

import { startBounded } from '../../../shared/bounded-process.ts'
import { type SandboxRuntimeConfig, sandboxLaunchArgv } from './sandbox.ts'

export function firstErrorLine(stderr: string | undefined): string {
  return stderr?.trim().split(/\r?\n/, 1)[0] || 'no stderr'
}

export async function launchSandboxProbe(
  profile: SandboxRuntimeConfig,
  executable: string,
  argv: string[],
  environment: Record<string, string>,
  scratchDir: string,
  options: { cwd?: string; environment?: Record<string, string> } = {},
) {
  return startBounded(await sandboxLaunchArgv(profile, executable, argv, scratchDir, environment), {
    budget: 'sandbox-probe',
    cwd: options.cwd,
    env: { ...process.env, ...environment, ...options.environment },
  })
}
