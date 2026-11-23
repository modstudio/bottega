// concern: confinement probe filesystem and command-cell verdict.

export type FilesystemProbeAccess = 'denied' | 'readable' | 'not covered'
type CommandProbeStatus = 'ran' | 'failed'
export type CommandProbe = { status: CommandProbeStatus; reason: string }
export type AccessTarget = {
  name: string
  path: string
  expected: 'denied' | 'readable'
  plant?: boolean
  createAfterLaunch?: boolean
}

type ProbeVerdict = {
  status: FilesystemProbeAccess | CommandProbeStatus | 'committed' | 'refused' | 'ok' | 'slow'
  reason?: string
}

export function probeVerdict(
  targets: readonly AccessTarget[],
  paths: Record<string, FilesystemProbeAccess>,
  commands: Record<string, CommandProbe>,
  missingExpectedReadableTargets: readonly string[] = [],
): ProbeVerdict {
  let filesystemVerdict: ProbeVerdict
  const missingTargetReason =
    missingExpectedReadableTargets.length > 0
      ? `expected-readable target missing on the host: ${missingExpectedReadableTargets.join(', ')}`
      : null
  if (targets.some(({ name, expected }) => expected === 'denied' && paths[name] === 'readable')) {
    filesystemVerdict = {
      status: 'readable',
      reason: `one or more denied paths were unexpectedly readable${missingTargetReason ? `; ${missingTargetReason}` : ''}`,
    }
  } else if (missingTargetReason) {
    filesystemVerdict = {
      status: 'not covered',
      reason: missingTargetReason,
    }
  } else if (targets.some(({ name }) => paths[name] === 'not covered')) {
    filesystemVerdict = {
      status: 'not covered',
      reason: 'one or more filesystem probe output lines were missing',
    }
  } else if (targets.some(({ name, expected }) => paths[name] !== expected)) {
    filesystemVerdict = {
      status: 'failed',
      reason: 'one or more expected-readable paths were denied',
    }
  } else {
    filesystemVerdict = { status: 'denied' }
  }
  return applyCommandCellVerdict(filesystemVerdict, commands)
}

export function applyCommandCellVerdict(
  filesystemVerdict: ProbeVerdict,
  commands: Record<string, CommandProbe>,
): ProbeVerdict {
  if (filesystemVerdict.status !== 'denied') return filesystemVerdict
  const failed = Object.entries(commands).find(([, command]) => command.status === 'failed')
  if (!failed) return filesystemVerdict
  const [name, command] = failed
  return { status: 'failed', reason: `command cell ${name} failed: ${command.reason}` }
}
