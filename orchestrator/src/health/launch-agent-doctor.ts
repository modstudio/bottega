// concern: doctor
/** Reports installer-owned launch agents without changing their launchd state. */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { InstallationKind } from '../../../shared/install-root.ts'
import {
  gatherLaunchAgentSkipFacts,
  launchAgentSkipReason,
} from '../../../shared/launch-agent-skip.ts'
import type { MachineLevel } from '../../../shared/machine-config.ts'
import {
  type InstalledPlistOwner,
  includesLaunchAgents,
  installationPlistOwners,
  isCheckoutOnlyLaunchAgentInstaller,
} from '../setup/launchd-owners.ts'
import { MAINTENANCE_SCHEDULE_LABELS } from '../setup/setup-schedules.ts'

export type LaunchAgentLoadObservation =
  | { kind: 'available'; loadedLabels: ReadonlySet<string> }
  | { kind: 'unavailable'; reason: 'launchctl missing' | 'gui domain unreachable' }

export type LaunchAgentDoctorDecision = {
  skipped: Array<{ label: string; reason: string }>
  findings: Array<{ label: string; command: string }>
  informational: Array<{ label: string; reason: 'not installed by a release install' }>
  schedules: Array<{
    label: string
    loaded: boolean | null
    lastRun: string
    skipReason: string | null
    remedy: string | null
  }>
  launchctlUnavailable: null | 'launchctl missing' | 'gui domain unreachable'
}

const maintenanceLabels = new Set<string>(MAINTENANCE_SCHEDULE_LABELS)

/** Classify installer-owned labels from already-gathered skip and launchd facts. */
export function decideLaunchAgentDoctor(input: {
  owners: readonly InstalledPlistOwner[]
  installationKind: InstallationKind | null
  machineLevel: MachineLevel
  skipReasons: Readonly<Record<string, string | null>>
  loadObservation: LaunchAgentLoadObservation
  lastRuns: Readonly<Record<string, string>>
}): LaunchAgentDoctorDecision {
  const skipped = input.owners.flatMap(({ label }) => {
    if (maintenanceLabels.has(label)) return []
    const reason = input.skipReasons[label]
    return reason ? [{ label, reason }] : []
  })
  const scheduleRemedy =
    input.installationKind === 'distribution'
      ? `${PLATFORM_SLUG} machine setup apply`
      : input.installationKind === 'checkout'
        ? (input.owners.find(({ label }) => maintenanceLabels.has(label))?.command ?? null)
        : null
  const observedLoadedLabels =
    input.loadObservation.kind === 'available' ? input.loadObservation.loadedLabels : null
  const schedules = input.owners
    .filter(({ label }) => maintenanceLabels.has(label))
    .map(({ label }) => {
      const loaded = observedLoadedLabels?.has(label) ?? null
      const skipReason = input.skipReasons[label] ?? null
      return {
        label,
        loaded,
        lastRun: input.lastRuns[label] ?? 'never',
        skipReason,
        remedy:
          input.machineLevel === 'full' && loaded === false && !skipReason ? scheduleRemedy : null,
      }
    })
  if (input.loadObservation.kind === 'unavailable') {
    return {
      skipped,
      findings: [],
      informational: [],
      schedules,
      launchctlUnavailable: input.loadObservation.reason,
    }
  }
  const { loadedLabels } = input.loadObservation
  const unloaded = input.owners.filter(
    ({ label }) => !input.skipReasons[label] && !loadedLabels.has(label),
  )
  const informational = unloaded
    .filter(
      ({ label, command }) =>
        !maintenanceLabels.has(label) &&
        input.installationKind !== 'checkout' &&
        isCheckoutOnlyLaunchAgentInstaller(command),
    )
    .map(({ label }) => ({ label, reason: 'not installed by a release install' }) as const)
  const informationalLabels = new Set(informational.map(({ label }) => label))
  return {
    skipped,
    findings: unloaded.filter(
      ({ label }) => !maintenanceLabels.has(label) && !informationalLabels.has(label),
    ),
    informational,
    schedules,
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

async function lastRunByLabel(
  owners: readonly InstalledPlistOwner[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const owner of owners) {
    if (!maintenanceLabels.has(owner.label) || !owner.standardOutPath) continue
    const path = owner.standardOutPath.replaceAll('__HOME__', homedir())
    try {
      const modified = (await stat(path)).mtime
      result[owner.label] = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(modified)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      result[owner.label] = 'never'
    }
  }
  return result
}

export type LaunchAgentDoctorReport = { lines: string[]; failed: boolean }

function scheduleLine(schedule: LaunchAgentDoctorDecision['schedules'][number]): string {
  const load =
    schedule.loaded === null ? 'LOAD UNAVAILABLE' : schedule.loaded ? 'loaded' : 'NOT LOADED'
  const suffix = schedule.skipReason
    ? `; skipped — ${schedule.skipReason}`
    : schedule.remedy
      ? `; run ${schedule.remedy}`
      : ''
  return `  ${schedule.label} ${load} — last run ${schedule.lastRun}${suffix}`
}

/** Gather installer and launchd facts, returning doctor measurements and refusal state. */
export async function launchAgentDoctorReport(
  platform: NodeJS.Platform,
  readOwners: () => Promise<InstalledPlistOwner[]> = installationPlistOwners,
  installationKind: InstallationKind | null,
  machineLevel: MachineLevel,
): Promise<LaunchAgentDoctorReport> {
  if (!includesLaunchAgents(platform)) return { lines: [], failed: false }
  let owners: InstalledPlistOwner[]
  try {
    owners = await readOwners()
  } catch {
    return {
      lines: ['launch agents', '  launchd templates unreadable — load check unavailable'],
      failed: false,
    }
  }
  const facts = gatherLaunchAgentSkipFacts()
  const skipReasons = Object.fromEntries(
    owners.map(({ label }) => [label, launchAgentSkipReason(label, facts)]),
  )
  const decision = decideLaunchAgentDoctor({
    owners,
    installationKind,
    machineLevel,
    skipReasons,
    loadObservation: loadedLaunchAgentLabels(owners, skipReasons),
    lastRuns: await lastRunByLabel(owners),
  })
  const lines = ['launch agents']
  for (const { label, reason } of decision.skipped) {
    lines.push(`  ${label} skipped — ${reason}`)
  }
  for (const schedule of decision.schedules) lines.push(scheduleLine(schedule))
  if (decision.launchctlUnavailable) {
    lines.push(`  ${decision.launchctlUnavailable} — load check unavailable`)
    return { lines, failed: false }
  }
  for (const { label, reason } of decision.informational) {
    lines.push(`  ${label} — ${reason}`)
  }
  for (const { label, command } of decision.findings) {
    lines.push(
      `  ${label} NOT LOADED — installer ${command}; run ${command} from the main checkout`,
    )
  }
  return {
    lines,
    failed: decision.schedules.some((schedule) => schedule.remedy !== null),
  }
}
