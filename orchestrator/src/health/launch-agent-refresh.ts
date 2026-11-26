// concern: launch-agent definition refresh
/** Plans and applies required missing definitions and installed definitions that drifted. */

import { join } from 'node:path'
import {
  type InstallationIdentity,
  type InstallationKind,
  runningInstallationIdentity,
} from '../../../shared/install-root.ts'
import { NOT_INSTALLED_BY_RELEASE_INSTALL } from '../../../shared/launch-agent-liveness.ts'
import { LAUNCHD_TEMPLATE_OWNERS } from '../../../shared/launchd-owners.ts'
import {
  isMaintenanceScheduleLabel,
  schedulePlatformSupported,
} from '../../../shared/schedule-policy.ts'
import {
  type InstalledPlistOwner,
  includesLaunchAgents,
  installationPlistOwners,
} from '../setup/launchd-owners.ts'
import type { ScheduleApplyResult, ScheduleSetupFact } from '../setup/setup-schedule-policy.ts'
import {
  applyMaintenanceSchedules,
  gatherScheduleSetupFacts,
} from '../setup/setup-schedule-runtime.ts'
import {
  installedDefinitionObservations,
  installerRemedy,
  type LaunchAgentDefinitionObservation,
} from './launch-agent-doctor.ts'

export type LaunchAgentRefreshPlan = {
  labels: Array<{ label: string; command: string }>
  checkoutCommands: string[]
  applyMaintenance: boolean
  unverified: Array<{ label: string; detail: string }>
  notReleaseInstalled: string[]
}

function definitionIsDrifted(observation: LaunchAgentDefinitionObservation | undefined): boolean {
  return observation?.comparison.kind === 'compared' && !observation.comparison.plistMatches
}

function maintenanceDefinitionNeedsRefresh(
  label: string,
  observation: LaunchAgentDefinitionObservation | undefined,
  required: ReadonlySet<string>,
): boolean {
  return definitionIsDrifted(observation) || (required.has(label) && observation === undefined)
}

/** Decide which installed definitions can be refreshed by the owning installation. */
export function decideLaunchAgentRefresh(input: {
  installationKind: InstallationKind
  owners: readonly InstalledPlistOwner[]
  machineLevel: 'record' | 'full'
  observations: Readonly<Record<string, LaunchAgentDefinitionObservation>>
  requiredMaintenanceLabels: ReadonlySet<string>
}): LaunchAgentRefreshPlan {
  const drifted = input.owners.filter(({ label }) => definitionIsDrifted(input.observations[label]))
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
  const releaseOwned = input.owners.filter(
    ({ label }) =>
      isMaintenanceScheduleLabel(label) &&
      maintenanceDefinitionNeedsRefresh(
        label,
        input.observations[label],
        input.requiredMaintenanceLabels,
      ),
  )
  return {
    labels: releaseOwned.map(({ label }) => ({
      label,
      command: installerRemedy(input.installationKind, null)!,
    })),
    checkoutCommands: [],
    applyMaintenance: releaseOwned.length > 0,
    unverified,
    notReleaseInstalled: drifted
      .filter(({ label }) => !isMaintenanceScheduleLabel(label))
      .map(({ label }) => label),
  }
}

type RefreshDependencies = {
  identity?: InstallationIdentity
  readOwners?: () => Promise<InstalledPlistOwner[]>
  observe?: (
    owners: readonly InstalledPlistOwner[],
    installationKind: InstallationKind,
  ) => Record<string, LaunchAgentDefinitionObservation>
  readScheduleFacts?: () => ScheduleSetupFact[]
  runCheckoutInstaller?: (root: string, command: string) => void
  applyMaintenance?: () => Promise<ScheduleApplyResult[]>
  requiredMaintenanceLabels?: () => readonly string[]
  readMachineLevel?: () => 'record' | 'full'
}

function distributionObservations(
  owners: readonly InstalledPlistOwner[],
  observe: RefreshDependencies['observe'],
  readScheduleFacts: NonNullable<RefreshDependencies['readScheduleFacts']>,
): Record<string, LaunchAgentDefinitionObservation> {
  const observations = observe
    ? observe(
        owners.filter(({ label }) => !isMaintenanceScheduleLabel(label)),
        'distribution',
      )
    : {}
  for (const fact of readScheduleFacts()) {
    if (!fact.installed) continue
    observations[fact.label] = {
      programPath: null,
      programExists: true,
      comparison: { kind: 'compared', plistMatches: fact.loaded && fact.definitionMatches },
    }
  }
  return observations
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

async function applyMaintenanceRefresh(
  apply: NonNullable<RefreshDependencies['applyMaintenance']>,
  presentation: { log(value: string): void },
): Promise<Set<string>> {
  const skippedLabels = new Set<string>()
  for (const result of await apply()) {
    if (result.status !== 'skipped') continue
    skippedLabels.add(result.label)
    presentation.log(`${result.label} skipped — ${result.reason}`)
  }
  return skippedLabels
}

async function refreshSupportedLaunchAgents(
  identity: InstallationIdentity,
  launchAgentsSupported: boolean,
  presentation: { log(value: string): void },
  deps: RefreshDependencies,
): Promise<void> {
  const owners = await (deps.readOwners ?? installationPlistOwners)()
  const observe = launchAgentsSupported
    ? (deps.observe ?? installedDefinitionObservations)
    : undefined
  const readScheduleFacts = deps.readScheduleFacts ?? gatherScheduleSetupFacts
  const observations =
    identity.kind === 'distribution'
      ? distributionObservations(owners, observe, readScheduleFacts)
      : observe!(owners, identity.kind)
  const requiredMaintenanceLabels = new Set(
    identity.kind === 'distribution' ? (deps.requiredMaintenanceLabels?.() ?? []) : [],
  )
  const plan = decideLaunchAgentRefresh({
    installationKind: identity.kind,
    machineLevel: deps.readMachineLevel?.() ?? 'full',
    owners,
    observations,
    requiredMaintenanceLabels,
  })
  for (const { label, detail } of plan.unverified) {
    presentation.log(`${label} unverified — ${detail}`)
  }
  for (const label of plan.notReleaseInstalled) {
    presentation.log(`${label} ${NOT_INSTALLED_BY_RELEASE_INSTALL}`)
  }
  const runInstaller = deps.runCheckoutInstaller ?? runCheckoutInstaller
  for (const command of plan.checkoutCommands) runInstaller(identity.root, command)
  const skippedLabels = plan.applyMaintenance
    ? await applyMaintenanceRefresh(
        deps.applyMaintenance ?? applyMaintenanceSchedules,
        presentation,
      )
    : new Set<string>()
  if (plan.labels.length === 0) return
  const after =
    identity.kind === 'distribution'
      ? distributionObservations(owners, observe, readScheduleFacts)
      : observe!(owners, identity.kind)
  const remaining = plan.labels.filter(
    ({ label }) =>
      !skippedLabels.has(label) &&
      maintenanceDefinitionNeedsRefresh(label, after[label], requiredMaintenanceLabels),
  )
  if (remaining.length > 0) {
    throw new Error(
      remaining
        .map(({ label, command }) => `${label} definition still drifted; run ${command}`)
        .join('\n'),
    )
  }
  for (const { label } of plan.labels) {
    if (!skippedLabels.has(label)) presentation.log(`${label} re-rendered`)
  }
}

/** Refresh drifted installed definitions, then prove each named definition now matches. */
export async function refreshLaunchAgents(
  platform: NodeJS.Platform,
  presentation: { log(value: string): void },
  deps: RefreshDependencies = {},
): Promise<void> {
  const launchAgentsSupported = includesLaunchAgents(platform)
  if (!launchAgentsSupported && !schedulePlatformSupported(platform)) return
  const identity = deps.identity ?? runningInstallationIdentity(import.meta.dir, process.env)
  if (identity.kind === 'checkout' && !launchAgentsSupported) return
  return refreshSupportedLaunchAgents(identity, launchAgentsSupported, presentation, deps)
}
