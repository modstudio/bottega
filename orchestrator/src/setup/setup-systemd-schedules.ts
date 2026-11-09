import { startBoundedSync } from '../../../shared/bounded-process.ts'
// concern: setup-systemd-schedules
/** Renders, observes, and installs Linux systemd user maintenance units. */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { readInstallAsset } from '../../../shared/embedded-assets.ts'
import { installationIdentity } from '../../../shared/install-root.ts'
import { gatherLaunchAgentSkipFacts } from '../../../shared/launch-agent-skip.ts'
import { recordSyncQueueDirectory, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import {
  MAINTENANCE_SCHEDULE_LABELS,
  type MaintenanceScheduleLabel,
  maintenanceSchedulePlan,
  renderMaintenanceSchedule,
  type ScheduleApplyResult,
  type ScheduleRenderValues,
  type ScheduleSetupFact,
  SYSTEMD_TEMPLATE_DIRECTORY,
  SYSTEMD_UNITS,
  systemdActivationUnits,
} from './setup-schedule-policy.ts'

function systemdUnitDirectory(values: ScheduleRenderValues): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(values.home, '.config')
  return join(configHome, 'systemd', 'user')
}

function renderedUnits(
  label: MaintenanceScheduleLabel,
  values: ScheduleRenderValues,
): Array<{ name: string; content: string }> {
  const identity = installationIdentity(import.meta.dir, {})
  return SYSTEMD_UNITS[label].map((name) => {
    const relative = `${SYSTEMD_TEMPLATE_DIRECTORY}/${name}`
    return {
      name,
      content: renderMaintenanceSchedule(
        readInstallAsset(relative, join(identity.root, relative)),
        values,
      ),
    }
  })
}

function systemctlPath(): string | null {
  return Bun.which('systemctl')
}

function commandSucceeded(argv: string[]): boolean {
  return startBoundedSync(argv, { budget: 'process-table' }).exitCode === 0
}

function activeUnit(systemctl: string | null, name: string): boolean {
  return systemctl !== null && commandSucceeded([systemctl, '--user', 'is-active', name])
}

/** Gather definition and activation facts without requiring a running user manager. */
export function gatherSystemdScheduleSetupFacts(values: ScheduleRenderValues): ScheduleSetupFact[] {
  const directory = systemdUnitDirectory(values)
  const systemctl = systemctlPath()
  const managerAvailable =
    systemctl !== null && commandSucceeded([systemctl, '--user', 'show-environment'])
  return MAINTENANCE_SCHEDULE_LABELS.map((label) => {
    const expected = renderedUnits(label, values)
    const installed = expected.every(({ name }) => existsSync(join(directory, name)))
    const definitionMatches = expected.every(({ name, content }) => {
      const target = join(directory, name)
      return existsSync(target) && readFileSync(target, 'utf8') === content
    })
    const activationUnits = systemdActivationUnits(label)
    return {
      label,
      installed,
      definitionMatches,
      loaded: managerAvailable && activationUnits.every((name) => activeUnit(systemctl, name)),
    }
  })
}

/** Read login linger; null means loginctl could not report it. */
export function gatherScheduleLingerFact(): boolean | null {
  const loginctl = Bun.which('loginctl')
  if (!loginctl) return null
  const result = startBoundedSync([loginctl, 'show-user', userInfo().username, '-p', 'Linger'], {
    budget: 'process-table',
  })
  if (result.exitCode !== 0) return null
  const value = result.stdout.toString().trim()
  if (value === 'Linger=yes') return true
  if (value === 'Linger=no') return false
  return null
}

export function gatherScheduleUserFact(): string {
  return userInfo().username
}

function requireSystemdUserManager(): string {
  const systemctl = systemctlPath()
  if (systemctl && commandSucceeded([systemctl, '--user', 'show-environment'])) return systemctl
  throw new Error(
    'systemd user manager is unavailable; run setup from a login session that has a systemd user manager',
  )
}

function runSystemctl(systemctl: string, args: string[]): void {
  const result = startBoundedSync([systemctl, '--user', ...args], { budget: 'process-table' })
  if (result.exitCode === 0) return
  const detail = `${result.stdout.toString()}${result.stderr.toString()}`.trim()
  throw new Error(`systemctl --user ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
}

async function writeChangedUnits(
  directory: string,
  units: readonly { name: string; content: string }[],
): Promise<string[]> {
  const changedNames: string[] = []
  for (const unit of units) {
    const target = join(directory, unit.name)
    let current: string | null = null
    try {
      current = await readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (current === unit.content) continue
    await writeFile(target, unit.content, 'utf8')
    changedNames.push(unit.name)
  }
  return changedNames
}

/** Install changed unit definitions and activate every timer and path unit. */
export async function applySystemdMaintenanceSchedules(
  values: ScheduleRenderValues,
): Promise<ScheduleApplyResult[]> {
  const systemctl = requireSystemdUserManager()
  const directory = systemdUnitDirectory(values)
  await mkdir(directory, { recursive: true })
  await mkdir(recordSyncQueueDirectory({ [STATE_HOME_ENV]: values.stateHome }), { recursive: true })
  const pending: Array<{
    label: MaintenanceScheduleLabel
    activationUnits: string[]
    changedActivationUnits: string[]
    changed: boolean
    loaded: boolean
  }> = []
  const results: ScheduleApplyResult[] = []

  for (const item of maintenanceSchedulePlan(gatherLaunchAgentSkipFacts())) {
    if (item.skipReason) {
      results.push({ label: item.label, status: 'skipped', reason: item.skipReason })
      continue
    }
    const units = renderedUnits(item.label, values)
    const changedNames = await writeChangedUnits(directory, units)
    const activationUnits = systemdActivationUnits(item.label)
    pending.push({
      label: item.label,
      activationUnits,
      changedActivationUnits: activationUnits.filter((name) => changedNames.includes(name)),
      changed: changedNames.length > 0,
      loaded: activationUnits.every((name) => activeUnit(systemctl, name)),
    })
  }

  runSystemctl(systemctl, ['daemon-reload'])
  for (const item of pending) {
    for (const unit of item.activationUnits) runSystemctl(systemctl, ['enable', '--now', unit])
    for (const unit of item.changedActivationUnits) runSystemctl(systemctl, ['restart', unit])
    results.push({
      label: item.label,
      status: item.changed || !item.loaded ? 'applied' : 'unchanged',
    })
  }
  return results
}
