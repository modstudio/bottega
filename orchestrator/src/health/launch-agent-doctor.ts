import { startBoundedSync } from '../../../shared/bounded-process.ts'
// concern: doctor
/** Reports installer-owned launch agents without changing their launchd state. */

import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readEnvValues } from '../../../shared/env-values.ts'
import {
  gitCommonDir,
  type InstallationKind,
  resolveInstallationPaths,
} from '../../../shared/install-root.ts'
import {
  FIX_DEFECT_BACKSTOP_SECONDS,
  type LaunchAgentRenderValues,
  launchAgentProgramPath,
  MONITOR_BACKSTOP_SECONDS,
  renderLaunchAgentTemplate,
} from '../../../shared/launch-agent-render.ts'
import {
  gatherLaunchAgentSkipFacts,
  launchAgentSkipReason,
} from '../../../shared/launch-agent-skip.ts'
import { type MachineLevel, readMachineValue } from '../../../shared/machine-config.ts'
import {
  RECORD_SYNC_PENDING_MARKER,
  recordSyncQueueDirectory,
  resolveStateRoot,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import {
  type InstalledPlistOwner,
  includesLaunchAgents,
  installationPlistOwners,
  isCheckoutOnlyLaunchAgentInstaller,
} from '../setup/launchd-owners.ts'
import { isMaintenanceScheduleLabel } from '../setup/setup-schedules.ts'
import { minutesOfDay } from '../spare/spare-decisions.ts'

export type LaunchAgentLoadObservation =
  | { kind: 'available'; loadedLabels: ReadonlySet<string> }
  | { kind: 'unavailable'; reason: 'launchctl missing' | 'gui domain unreachable' }

export type LaunchAgentDoctorDecision = {
  skipped: Array<{ label: string; reason: string }>
  findings: Array<{ label: string; command: string }>
  informational: Array<{ label: string; reason: 'not installed by a release install' }>
  definitionFindings: Array<{
    label: string
    reason: 'program missing' | 'definition drifted'
    detail: string
    command: string
  }>
  definitionUnverified: Array<{
    label: string
    detail: string
    command: string | null
  }>
  schedules: Array<{
    label: string
    loaded: boolean | null
    lastRun: string
    skipReason: string | null
    remedy: string | null
  }>
  launchctlUnavailable: null | 'launchctl missing' | 'gui domain unreachable'
}

export function installerRemedy(
  installationKind: InstallationKind | null,
  ownerCommand: string | null,
): string | null {
  if (installationKind === 'distribution') return `${PLATFORM_SLUG} machine setup apply`
  if (installationKind === 'checkout') return ownerCommand
  return null
}

export type LaunchAgentDefinitionObservation = {
  programPath: string | null
  programExists: boolean
  comparison:
    | { kind: 'compared'; plistMatches: boolean }
    | { kind: 'unavailable'; detail: string; command: string | null }
}

/** Classify installer-owned labels from already-gathered skip and launchd facts. */
export function decideLaunchAgentDoctor(input: {
  owners: readonly InstalledPlistOwner[]
  installationKind: InstallationKind | null
  machineLevel: MachineLevel
  skipReasons: Readonly<Record<string, string | null>>
  loadObservation: LaunchAgentLoadObservation
  lastRuns: Readonly<Record<string, string>>
  definitions?: Readonly<Record<string, LaunchAgentDefinitionObservation>>
}): LaunchAgentDoctorDecision {
  const skipped = input.owners.flatMap(({ label }) => {
    if (isMaintenanceScheduleLabel(label)) return []
    const reason = input.skipReasons[label]
    return reason ? [{ label, reason }] : []
  })
  const scheduleRemedy = installerRemedy(
    input.installationKind,
    input.owners.find(({ label }) => isMaintenanceScheduleLabel(label))?.command ?? null,
  )
  const observedLoadedLabels =
    input.loadObservation.kind === 'available' ? input.loadObservation.loadedLabels : null
  const definitionFindings: LaunchAgentDoctorDecision['definitionFindings'] = []
  const definitionUnverified: LaunchAgentDoctorDecision['definitionUnverified'] = []
  for (const { label, command } of input.owners) {
    const observation = input.definitions?.[label]
    if (!observation) continue
    const remedy = installerRemedy(input.installationKind, command) ?? command
    if (observation.programPath && !observation.programExists) {
      definitionFindings.push({
        label,
        reason: 'program missing',
        detail: observation.programPath,
        command: remedy,
      })
    } else if (observation.comparison.kind === 'unavailable') {
      definitionUnverified.push({
        label,
        detail: observation.comparison.detail,
        command: observation.comparison.command,
      })
    } else if (!observation.comparison.plistMatches) {
      definitionFindings.push({
        label,
        reason: 'definition drifted',
        detail: 'installed plist differs from the current template',
        command: remedy,
      })
    }
  }
  const schedules = input.owners
    .filter(({ label }) => isMaintenanceScheduleLabel(label))
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
      definitionFindings,
      definitionUnverified,
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
        !isMaintenanceScheduleLabel(label) &&
        input.installationKind !== 'checkout' &&
        isCheckoutOnlyLaunchAgentInstaller(command),
    )
    .map(({ label }) => ({ label, reason: 'not installed by a release install' }) as const)
  const informationalLabels = new Set(informational.map(({ label }) => label))
  return {
    skipped,
    findings: unloaded.filter(
      ({ label }) => !isMaintenanceScheduleLabel(label) && !informationalLabels.has(label),
    ),
    informational,
    definitionFindings,
    definitionUnverified,
    schedules,
    launchctlUnavailable: null,
  }
}

export function launchAgentOwningRoot(input: {
  installationKind: InstallationKind | null
  runningRoot: string
  configuredMainCheckout?: string
  discoveredMainCheckout?: string
}): string {
  if (input.installationKind !== 'checkout') return input.runningRoot
  return input.configuredMainCheckout ?? input.discoveredMainCheckout ?? input.runningRoot
}

/** Resolve both reproducible-definition inputs from one owning installation. */
export function launchAgentDefinitionSource(
  input: Parameters<typeof launchAgentOwningRoot>[0] & { templatePath?: string },
): { root: string; templatePath: string | null } {
  const root = launchAgentOwningRoot(input)
  return { root, templatePath: input.templatePath ? join(root, input.templatePath) : null }
}

export function launchAgentComparisonAvailability(input: {
  template: string
  flyctl: string | null
  hostedUrl: string | undefined
  spareStartTime: string
}):
  | { kind: 'available'; spareStartMinutes: number }
  | {
      kind: 'unavailable'
      detail: string
      command: string | null
    } {
  const details: string[] = []
  let command: string | null = null
  let spareStartMinutes = 0
  if (input.template.includes('__FLYCTL__') && !input.flyctl)
    details.push('flyctl is not installed')
  if (input.template.includes('__HUB_HOSTED_URL__') && !input.hostedUrl)
    details.push('BOTTEGA_HOSTED_URL does not resolve')
  try {
    spareStartMinutes = minutesOfDay(input.spareStartTime)
  } catch {
    if (
      input.template.includes('__SPARE_START_HOUR__') ||
      input.template.includes('__SPARE_START_MINUTE__')
    ) {
      details.push(`spare.start_time is not HH:MM (got '${input.spareStartTime}')`)
      command = `${PLATFORM_SLUG} machine config set spare.start_time HH:MM`
    }
  }
  return details.length > 0
    ? { kind: 'unavailable', detail: details.join('; '), command }
    : { kind: 'available', spareStartMinutes }
}

function currentRenderValues(
  owner: InstalledPlistOwner,
  sourceRoot: string,
  spareStartMinutes: number,
  flyctl: string,
  hostedUrl: string,
): LaunchAgentRenderValues {
  const paths = resolveInstallationPaths(sourceRoot, {})
  const home = homedir()
  const concern = owner.templatePath?.startsWith('hub/') ? paths.hubAssets : paths.ops
  const stateHome = resolveStateRoot(process.env)
  return {
    __INSTALL_ROOT__: paths.root,
    __BOTTEGA_BIN__: paths.executable,
    __CONCERN__: concern,
    __HOME__: home,
    __STATE_HOME_ENV__: STATE_HOME_ENV,
    __STATE_HOME__: stateHome,
    __RECORD_SYNC_QUEUE__: recordSyncQueueDirectory({ [STATE_HOME_ENV]: stateHome }),
    __RECORD_SYNC_MARKER__: RECORD_SYNC_PENDING_MARKER,
    __MONITOR_BACKSTOP_SECONDS__: String(MONITOR_BACKSTOP_SECONDS),
    __FIX_DEFECT_BACKSTOP_SECONDS__: String(FIX_DEFECT_BACKSTOP_SECONDS),
    __MODEL_HOST__: String(readMachineValue('model_host.ssh_alias')),
    __TUNNEL_LOCAL_PORT__: String(readMachineValue('model_host.tunnel_local_port')),
    __TUNNEL_REMOTE_PORT__: String(readMachineValue('model_host.tunnel_remote_port')),
    __FLYCTL__: flyctl,
    __SPARE_START_HOUR__: String(Math.floor(spareStartMinutes / 60)),
    __SPARE_START_MINUTE__: String(spareStartMinutes % 60),
    __RECORD_TUNNEL_APP__: String(readMachineValue('record.tunnel_app')),
    __RECORD_TUNNEL_LOCAL_PORT__: String(readMachineValue('record.tunnel_local_port')),
    __RECORD_TUNNEL_REMOTE_PORT__: String(readMachineValue('record.tunnel_remote_port')),
    __HUB_PORT__: String(readMachineValue('hub.port')),
    __HUB_HOSTED_URL__: hostedUrl,
  }
}

export function installedDefinitionObservations(
  owners: readonly InstalledPlistOwner[],
  installationKind: InstallationKind | null,
): Record<string, LaunchAgentDefinitionObservation> {
  const agents = join(homedir(), 'Library', 'LaunchAgents')
  const observations: Record<string, LaunchAgentDefinitionObservation> = {}
  const runningPaths = resolveInstallationPaths(import.meta.dir, process.env)
  const discoveredMainCheckout =
    installationKind === 'checkout' && !process.env.BOTTEGA_MAIN_CHECKOUT
      ? gitCommonDir(runningPaths.root)
      : null
  const sourceInput = {
    installationKind,
    runningRoot: runningPaths.root,
    configuredMainCheckout: process.env.BOTTEGA_MAIN_CHECKOUT,
    discoveredMainCheckout: discoveredMainCheckout ? dirname(discoveredMainCheckout) : undefined,
  }
  const flyctl = Bun.which('flyctl')
  const hostedUrl = readEnvValues(['BOTTEGA_HOSTED_URL'], process.env).BOTTEGA_HOSTED_URL
  const spareStartTime = String(readMachineValue('spare.start_time'))
  for (const owner of owners) {
    if (!owner.template) continue
    const target = join(agents, `${owner.label}.plist`)
    if (!existsSync(target)) continue
    const installed = readFileSync(target, 'utf8')
    const programPath = launchAgentProgramPath(installed)
    const source = launchAgentDefinitionSource({ ...sourceInput, templatePath: owner.templatePath })
    const template =
      installationKind === 'checkout' && source.templatePath
        ? readFileSync(source.templatePath, 'utf8')
        : owner.template
    const availability = launchAgentComparisonAvailability({
      template,
      flyctl,
      hostedUrl,
      spareStartTime,
    })
    observations[owner.label] = {
      programPath,
      programExists: programPath !== null && existsSync(programPath),
      comparison:
        availability.kind === 'unavailable'
          ? availability
          : {
              kind: 'compared',
              plistMatches:
                installed ===
                renderLaunchAgentTemplate(
                  template,
                  currentRenderValues(
                    owner,
                    source.root,
                    availability.spareStartMinutes,
                    flyctl ?? '',
                    hostedUrl ?? '',
                  ),
                ),
            },
    }
  }
  return observations
}

function loadedLaunchAgentLabels(
  owners: readonly InstalledPlistOwner[],
  skipReasons: Readonly<Record<string, string | null>>,
): LaunchAgentLoadObservation {
  const launchctl = Bun.which('launchctl')
  const uid = process.getuid?.()
  if (!launchctl || uid === undefined) return { kind: 'unavailable', reason: 'launchctl missing' }
  const domain = startBoundedSync([launchctl, 'print', `gui/${uid}`], { budget: 'process-table' })
  if (domain.exitCode !== 0) return { kind: 'unavailable', reason: 'gui domain unreachable' }
  const loaded = new Set<string>()
  for (const { label } of owners) {
    if (skipReasons[label] && !isMaintenanceScheduleLabel(label)) continue
    const child = startBoundedSync([launchctl, 'print', `gui/${uid}/${label}`], { budget: 'process-table' })
    if (child.exitCode === 0) loaded.add(label)
  }
  return { kind: 'available', loadedLabels: loaded }
}

async function lastRunByLabel(
  owners: readonly InstalledPlistOwner[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const owner of owners) {
    if (!isMaintenanceScheduleLabel(owner.label) || !owner.standardOutPath) continue
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

/** Doctor fails when any worker schedule carries a remedy. */
export function schedulesFailed(decision: LaunchAgentDoctorDecision): boolean {
  return decision.schedules.some((schedule) => schedule.remedy !== null)
}

export function scheduleLine(schedule: LaunchAgentDoctorDecision['schedules'][number]): string {
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
    definitions: installedDefinitionObservations(owners, installationKind),
  })
  const lines = ['launch agents']
  for (const { label, reason } of decision.skipped) {
    lines.push(`  ${label} skipped — ${reason}`)
  }
  for (const schedule of decision.schedules) lines.push(scheduleLine(schedule))
  for (const { label, reason, detail, command } of decision.definitionFindings) {
    lines.push(`  ${label} ${reason.toUpperCase()} — ${detail}; run ${command}`)
  }
  for (const { label, detail, command } of decision.definitionUnverified) {
    lines.push(`  ${label} CANNOT COMPARE — ${detail}${command ? `; run ${command}` : ''}`)
  }
  if (decision.launchctlUnavailable) {
    lines.push(`  ${decision.launchctlUnavailable} — load check unavailable`)
    return { lines, failed: decision.definitionFindings.length > 0 }
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
    failed: schedulesFailed(decision) || decision.definitionFindings.length > 0,
  }
}
