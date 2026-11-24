// concern: shared confinement-probe launch and process-error formatting.

import { startBounded } from '../../../shared/bounded-process.ts'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { BUILTIN_AGENTS } from '../agent/agents.ts'
import { workerChildEnvironment } from '../run/run-worker-home.ts'
import type { CommandProbe } from './confinement-probe-verdict.ts'
import { type SandboxRuntimeConfig, sandboxLaunchArgv } from './sandbox.ts'

export type TaskReadCommands = {
  own: { argv: string[]; label: string }
  refused: { argv: string[]; label: string }
}

export function probeWorkerEnvironment(input: {
  environment: Record<string, string>
  askUrl: string
  runId: string
  runToken: string
}): Record<string, string> {
  const child = workerChildEnvironment({
    agent: BUILTIN_AGENTS.grok!,
    sandbox: 'srt',
    runRecordId: input.runId,
    runToken: input.runToken,
    runNumber: 1,
    environment: input.environment,
    stateEnvironment: input.environment,
    includeStore: true,
  })
  child.BOTTEGA_ORCHESTRATOR_DB = resolveOrchestratorDatabase(input.environment)
  child.BOTTEGA_ASK_URL = input.askUrl
  return child
}

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

export async function launchCommand(
  profile: SandboxRuntimeConfig,
  argv: string[],
  environment: Record<string, string>,
  scratchDir: string,
  cwd: string,
  hubOpenMode?: string,
  launcher: typeof launchSandboxProbe = launchSandboxProbe,
): Promise<CommandProbe> {
  const result = await launcher(profile, argv[0]!, argv.slice(1), environment, scratchDir, { cwd })
  return {
    status: result.exitCode === 0 ? 'ran' : 'failed',
    reason: `exit ${result.exitCode ?? 'unknown'}${result.exitCode === 0 ? '' : `: ${firstErrorLine(result.stderr)}`}${hubOpenMode ? `; hub open mode: ${hubOpenMode}` : ''}`,
  }
}

async function launchRefusedTaskRead(
  profile: SandboxRuntimeConfig,
  argv: string[],
  environment: Record<string, string>,
  scratchDir: string,
  cwd: string,
  hubOpenMode: string,
): Promise<CommandProbe> {
  const result = await launchSandboxProbe(
    profile,
    argv[0]!,
    argv.slice(1),
    environment,
    scratchDir,
    { cwd },
  )
  const refusal = 'read refused: the requested task is outside run task'
  const refused = result.exitCode !== 0 && result.stderr.includes(refusal)
  return {
    status: refused ? 'ran' : 'failed',
    reason: refused
      ? `exit ${result.exitCode}: ${firstErrorLine(result.stderr)}`
      : `expected nonzero with ${refusal}; exit ${result.exitCode ?? 'unknown'}: ${firstErrorLine(result.stderr)}; hub open mode: ${hubOpenMode}`,
  }
}

export async function launchTaskReadCommands(
  profile: SandboxRuntimeConfig,
  commands: TaskReadCommands,
  environment: Record<string, string>,
  scratchDir: string,
  cwd: string,
  hubOpenMode: string,
): Promise<Record<string, CommandProbe>> {
  const own = await launchCommand(
    profile,
    commands.own.argv,
    environment,
    scratchDir,
    cwd,
    hubOpenMode,
  )
  const refused = await launchRefusedTaskRead(
    profile,
    commands.refused.argv,
    environment,
    scratchDir,
    cwd,
    hubOpenMode,
  )
  return { [commands.own.label]: own, [commands.refused.label]: refused }
}
