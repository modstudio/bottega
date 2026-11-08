import { readMachineValue } from './machine-config.ts'

export type LaunchAgentSkipFacts = {
  modelHostAlias: string
  recordTunnelApp: string
  flyctlOnPath: boolean
}

/** Decide whether an installer omits a launch agent from plain machine facts. */
export function launchAgentSkipReason(label: string, facts: LaunchAgentSkipFacts): string | null {
  if (label === 'com.user.local-model-tunnel' && !facts.modelHostAlias) {
    return 'model_host.ssh_alias is unset'
  }
  if (label === 'com.user.record-tunnel' && !facts.recordTunnelApp) {
    return 'record.tunnel_app is unset'
  }
  if (label === 'com.user.record-tunnel' && !facts.flyctlOnPath) {
    return 'flyctl is not on PATH'
  }
  return null
}

/** Read the same machine configuration and PATH sources used by the installer. */
export function gatherLaunchAgentSkipFacts(): LaunchAgentSkipFacts {
  return {
    modelHostAlias: readMachineValue('model_host.ssh_alias'),
    recordTunnelApp: readMachineValue('record.tunnel_app'),
    flyctlOnPath: Bun.which('flyctl') !== null,
  }
}

if (import.meta.main) {
  const [command, label] = process.argv.slice(2)
  if (command !== 'skip-reason' || !label) {
    throw new Error('working form: bun shared/launch-agent-skip.ts skip-reason <label>')
  }
  const reason = launchAgentSkipReason(label, gatherLaunchAgentSkipFacts())
  if (reason) console.log(reason)
}
