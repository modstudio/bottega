// concern: record-tunnel-error
/** Owns record tunnel configuration classification and its unconfigured and down remedies. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { runningInstallationKind } from '../../../shared/install-root.ts'
import { installerRemedy } from '../health/launch-agent-doctor.ts'
import { launchdOwnerCommand } from '../setup/launchd-owners.ts'

const CONNECTION_FAILURE =
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b|failed to connect|connection (?:refused|closed|reset)|connect(?:ion)? timed out|connection timeout/i

const RECORD_TUNNEL_REMEDY = 'launchctl kickstart -k gui/$(id -u)/com.user.record-tunnel'

export const RECORD_TUNNEL_DOWN_REMEDY = `run ${RECORD_TUNNEL_REMEDY}`

/** Render the configuration and installation remedy for this running installation. */
export function recordTunnelUnconfiguredRemedy(): string {
  const installCommand = installerRemedy(
    runningInstallationKind(import.meta.dir, process.env),
    launchdOwnerCommand('ops'),
  )
  if (!installCommand) throw new Error('record tunnel remedy has no installer command')
  return `run ${PLATFORM_SLUG} machine config set --machine record.tunnel_app <fly-app>, then re-run ${installCommand} to install com.user.record-tunnel`
}

export type RecordTunnelConfigurationFacts = {
  requiresTunnel: boolean
  tunnelApp: string
}

/** Decide whether this machine needs the record tunnel but has no app configured for it. */
export function recordTunnelIsUnconfigured(facts: RecordTunnelConfigurationFacts): boolean {
  return facts.requiresTunnel && !facts.tunnelApp
}

/** Add the applicable supervised-tunnel remedy only to connection-class failures. */
export function recordTunnelFailure(
  message: string,
  facts: RecordTunnelConfigurationFacts,
): string {
  if (!CONNECTION_FAILURE.test(message)) return message
  if (recordTunnelIsUnconfigured(facts))
    return `${message}\nrecord tunnel is unconfigured; ${recordTunnelUnconfiguredRemedy()}`
  if (!facts.tunnelApp) return message
  return `${message}\nrecord tunnel com.user.record-tunnel is unavailable; ${RECORD_TUNNEL_DOWN_REMEDY}`
}
