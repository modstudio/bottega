// concern: doctor
/** Reports installer-owned launch agents without changing their launchd state. */

import {
  gatherLaunchAgentSkipFacts,
  launchAgentSkipReason,
} from '../../../shared/launch-agent-skip.ts'
import { type InstalledPlistOwner, installationPlistOwners } from '../setup/setup-environment.ts'

export type LaunchAgentDoctorDecision = {
  skipped: Array<{ label: string; reason: string }>
  findings: Array<{ label: string; command: string }>
  launchctlUnavailable: boolean
}

/** Classify installer-owned labels from already-gathered skip and launchd facts. */
export function decideLaunchAgentDoctor(input: {
  owners: readonly InstalledPlistOwner[]
  skipReasons: Readonly<Record<string, string | null>>
  loadedLabels: ReadonlySet<string> | null
}): LaunchAgentDoctorDecision {
  const skipped = input.owners.flatMap(({ label }) => {
    const reason = input.skipReasons[label]
    return reason ? [{ label, reason }] : []
  })
  if (input.loadedLabels === null) {
    return { skipped, findings: [], launchctlUnavailable: true }
  }
  const findings = input.owners.filter(
    ({ label }) => !input.skipReasons[label] && !input.loadedLabels?.has(label),
  )
  return { skipped, findings, launchctlUnavailable: false }
}

function loadedLaunchAgentLabels(
  owners: readonly InstalledPlistOwner[],
  skipReasons: Readonly<Record<string, string | null>>,
): Set<string> | null {
  const launchctl = Bun.which('launchctl')
  const uid = process.getuid?.()
  if (!launchctl || uid === undefined) return null
  const loaded = new Set<string>()
  for (const { label } of owners) {
    if (skipReasons[label]) continue
    const child = Bun.spawnSync([launchctl, 'print', `gui/${uid}/${label}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    if (child.exitCode === 0) loaded.add(label)
  }
  return loaded
}

/** Gather installer and launchd facts, returning report-only doctor lines. */
export async function launchAgentDoctorLines(): Promise<string[]> {
  const owners = await installationPlistOwners()
  const facts = gatherLaunchAgentSkipFacts()
  const skipReasons = Object.fromEntries(
    owners.map(({ label }) => [label, launchAgentSkipReason(label, facts)]),
  )
  const decision = decideLaunchAgentDoctor({
    owners,
    skipReasons,
    loadedLabels: loadedLaunchAgentLabels(owners, skipReasons),
  })
  const lines = ['launch agents']
  for (const { label, reason } of decision.skipped) {
    lines.push(`  ${label} skipped — ${reason}`)
  }
  if (decision.launchctlUnavailable) {
    lines.push('  launchctl unavailable — load check unavailable')
    return lines
  }
  for (const { label, command } of decision.findings) {
    lines.push(
      `  ${label} NOT LOADED — installer ${command}; run ${command} from the main checkout`,
    )
  }
  return lines
}
