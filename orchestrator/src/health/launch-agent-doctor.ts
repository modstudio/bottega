// concern: doctor
/** Reports installer-owned launch agents without changing their launchd state. */

import type { InstallationKind } from '../../../shared/install-root.ts'
import {
  gatherLaunchAgentSkipFacts,
  launchAgentSkipReason,
} from '../../../shared/launch-agent-skip.ts'
import {
  type InstalledPlistOwner,
  includesLaunchAgents,
  installationPlistOwners,
  isCheckoutOnlyLaunchAgentInstaller,
} from '../setup/launchd-owners.ts'

export type LaunchAgentLoadObservation =
  | { kind: 'available'; loadedLabels: ReadonlySet<string> }
  | { kind: 'unavailable'; reason: 'launchctl missing' | 'gui domain unreachable' }

export type LaunchAgentDoctorDecision = {
  skipped: Array<{ label: string; reason: string }>
  findings: Array<{ label: string; command: string }>
  informational: Array<{ label: string; reason: 'not installed by a release install' }>
  launchctlUnavailable: null | 'launchctl missing' | 'gui domain unreachable'
}

/** Classify installer-owned labels from already-gathered skip and launchd facts. */
export function decideLaunchAgentDoctor(input: {
  owners: readonly InstalledPlistOwner[]
  installationKind: InstallationKind
  skipReasons: Readonly<Record<string, string | null>>
  loadObservation: LaunchAgentLoadObservation
}): LaunchAgentDoctorDecision {
  const skipped = input.owners.flatMap(({ label }) => {
    const reason = input.skipReasons[label]
    return reason ? [{ label, reason }] : []
  })
  if (input.loadObservation.kind === 'unavailable') {
    return {
      skipped,
      findings: [],
      informational: [],
      launchctlUnavailable: input.loadObservation.reason,
    }
  }
  const { loadedLabels } = input.loadObservation
  const unloaded = input.owners.filter(
    ({ label }) => !input.skipReasons[label] && !loadedLabels.has(label),
  )
  const informational = unloaded
    .filter(
      ({ command }) =>
        input.installationKind === 'distribution' && isCheckoutOnlyLaunchAgentInstaller(command),
    )
    .map(({ label }) => ({ label, reason: 'not installed by a release install' }) as const)
  const informationalLabels = new Set(informational.map(({ label }) => label))
  return {
    skipped,
    findings: unloaded.filter(({ label }) => !informationalLabels.has(label)),
    informational,
    launchctlUnavailable: null,
  }
}

function loadedLaunchAgentLabels(
  owners: readonly InstalledPlistOwner[],
  skipReasons: Readonly<Record<string, string | null>>,
): LaunchAgentLoadObservation {
  const launchctl = Bun.which('launchctl')
  const uid = process.getuid?.()
  if (!launchctl || uid === undefined) return { kind: 'unavailable', reason: 'launchctl missing' }
  const domain = Bun.spawnSync([launchctl, 'print', `gui/${uid}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if (domain.exitCode !== 0) return { kind: 'unavailable', reason: 'gui domain unreachable' }
  const loaded = new Set<string>()
  for (const { label } of owners) {
    if (skipReasons[label]) continue
    const child = Bun.spawnSync([launchctl, 'print', `gui/${uid}/${label}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    if (child.exitCode === 0) loaded.add(label)
  }
  return { kind: 'available', loadedLabels: loaded }
}

/** Gather installer and launchd facts, returning report-only doctor lines. */
export async function launchAgentDoctorLines(
  platform: NodeJS.Platform,
  readOwners: () => Promise<InstalledPlistOwner[]> = installationPlistOwners,
  installationKind: InstallationKind = 'checkout',
): Promise<string[]> {
  if (!includesLaunchAgents(platform)) return []
  let owners: InstalledPlistOwner[]
  try {
    owners = await readOwners()
  } catch {
    return ['launch agents', '  launchd templates unreadable — load check unavailable']
  }
  const facts = gatherLaunchAgentSkipFacts()
  const skipReasons = Object.fromEntries(
    owners.map(({ label }) => [label, launchAgentSkipReason(label, facts)]),
  )
  const decision = decideLaunchAgentDoctor({
    owners,
    installationKind,
    skipReasons,
    loadObservation: loadedLaunchAgentLabels(owners, skipReasons),
  })
  const lines = ['launch agents']
  for (const { label, reason } of decision.skipped) {
    lines.push(`  ${label} skipped — ${reason}`)
  }
  if (decision.launchctlUnavailable) {
    lines.push(`  ${decision.launchctlUnavailable} — load check unavailable`)
    return lines
  }
  for (const { label, reason } of decision.informational) {
    lines.push(`  ${label} — ${reason}`)
  }
  for (const { label, command } of decision.findings) {
    lines.push(
      `  ${label} NOT LOADED — installer ${command}; run ${command} from the main checkout`,
    )
  }
  return lines
}
