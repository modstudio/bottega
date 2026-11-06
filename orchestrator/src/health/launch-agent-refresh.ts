// concern: launch-agent definition refresh
/** Plans and applies refreshes only for installed launch-agent definitions that drifted. */

import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type InstallationKind, runningInstallationIdentity } from '../../../shared/install-root.ts'
import {
  type InstalledPlistOwner,
  includesLaunchAgents,
  installationPlistOwners,
  LAUNCHD_TEMPLATE_OWNERS,
} from '../setup/launchd-owners.ts'
import { applyMaintenanceSchedules, MAINTENANCE_SCHEDULE_LABELS } from '../setup/setup-schedules.ts'
import {
  installedDefinitionObservations,
  type LaunchAgentDefinitionObservation,
} from './launch-agent-doctor.ts'

export type LaunchAgentRefreshPlan = {
  labels: Array<{ label: string; command: string }>
  checkoutCommands: string[]
  applyMaintenance: boolean
  unverified: Array<{ label: string; detail: string }>
  notReleaseInstalled: string[]
}

const maintenanceLabels = new Set<string>(MAINTENANCE_SCHEDULE_LABELS)

/** Decide which installed definitions can be refreshed by the owning installation. */
export function decideLaunchAgentRefresh(input: {
  installationKind: InstallationKind
  owners: readonly InstalledPlistOwner[]
  observations: Readonly<Record<string, LaunchAgentDefinitionObservation>>
}): LaunchAgentRefreshPlan {
  const drifted = input.owners.filter(({ label }) => {
    const comparison = input.observations[label]?.comparison
    return comparison?.kind === 'compared' && !comparison.plistMatches
  })
  const unverified = input.owners.flatMap(({ label }) => {
    const comparison = input.observations[label]?.comparison
    return comparison?.kind === 'unavailable' ? [{ label, detail: comparison.detail }] : []
  })
  if (input.installationKind === 'checkout') {
    const driftedCommands = new Set(drifted.map(({ command }) => command))
    return {
      labels: drifted.map(({ label, command }) => ({ label, command })),
      checkoutCommands: LAUNCHD_TEMPLATE_OWNERS.flatMap(({ command }) =>
        driftedCommands.has(command) ? [command] : [],
      ),
      applyMaintenance: false,
      unverified,
      notReleaseInstalled: [],
    }
  }
  const releaseOwned = drifted.filter(({ label }) => maintenanceLabels.has(label))
  return {
    labels: releaseOwned.map(({ label }) => ({
      label,
      command: `${PLATFORM_SLUG} machine setup apply`,
    })),
    checkoutCommands: [],
    applyMaintenance: releaseOwned.length > 0,
    unverified,
    notReleaseInstalled: drifted
      .filter(({ label }) => !maintenanceLabels.has(label))
      .map(({ label }) => label),
  }
}

type RefreshDependencies = {
  readOwners?: () => Promise<InstalledPlistOwner[]>
  observe?: (
    owners: readonly InstalledPlistOwner[],
    installationKind: InstallationKind,
  ) => Record<string, LaunchAgentDefinitionObservation>
  runCheckoutInstaller?: (root: string, command: string) => void
  applyMaintenance?: () => Promise<unknown>
}

function runCheckoutInstaller(root: string, command: string): void {
  const result = Bun.spawnSync([join(root, command)], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed with exit ${result.exitCode}; run ${command} from ${root}`)
  }
}

/** Refresh drifted installed definitions, then prove each named definition now matches. */
export async function refreshLaunchAgents(
  platform: NodeJS.Platform,
  presentation: { log(value: string): void },
  deps: RefreshDependencies = {},
): Promise<void> {
  if (!includesLaunchAgents(platform)) return
  const identity = runningInstallationIdentity(import.meta.dir, process.env)
  const owners = await (deps.readOwners ?? installationPlistOwners)()
  const observe = deps.observe ?? installedDefinitionObservations
  const plan = decideLaunchAgentRefresh({
    installationKind: identity.kind,
    owners,
    observations: observe(owners, identity.kind),
  })
  for (const { label, detail } of plan.unverified) {
    presentation.log(`${label} unverified — ${detail}`)
  }
  for (const label of plan.notReleaseInstalled) {
    presentation.log(`${label} not installed by a release install`)
  }
  const runInstaller = deps.runCheckoutInstaller ?? runCheckoutInstaller
  for (const command of plan.checkoutCommands) runInstaller(identity.root, command)
  if (plan.applyMaintenance) {
    await (deps.applyMaintenance ?? applyMaintenanceSchedules)()
  }
  if (plan.labels.length === 0) return
  const after = observe(owners, identity.kind)
  const remaining = plan.labels.filter(({ label }) => {
    const comparison = after[label]?.comparison
    return comparison?.kind === 'compared' && !comparison.plistMatches
  })
  if (remaining.length > 0) {
    throw new Error(
      remaining
        .map(({ label, command }) => `${label} definition still drifted; run ${command}`)
        .join('\n'),
    )
  }
  for (const { label } of plan.labels) presentation.log(`${label} re-rendered`)
}
