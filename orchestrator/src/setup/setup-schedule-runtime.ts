// concern: setup-schedule-runtime
/** Routes maintenance schedule facts and application to the host platform adapter. */

import { homedir } from 'node:os'
import { runningInstallationIdentity } from '../../../shared/install-root.ts'
import { schedulePlatformSupported } from '../../../shared/schedule-policy.ts'
import { resolveStateRoot, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type {
  ScheduleApplyResult,
  ScheduleRenderValues,
  ScheduleSetupFact,
} from './setup-schedule-policy.ts'
import {
  applyLaunchdMaintenanceSchedules,
  gatherLaunchdScheduleSetupFacts,
  restartLongRunningLaunchdSchedules,
} from './setup-schedules.ts'
import {
  applySystemdMaintenanceSchedules,
  gatherScheduleLingerFact as gatherSystemdScheduleLingerFact,
  gatherSystemdScheduleSetupFacts,
  gatherScheduleUserFact as gatherSystemdScheduleUserFact,
  restartLongRunningSystemdSchedules,
  systemdUserManagerAvailable,
} from './setup-systemd-schedules.ts'

export type LongRunningScheduleRestartResult = {
  label: string
  status: 'restarted' | 'inactive' | 'unreachable'
  command: string
}

export function scheduleUserManagerAvailable(platform: NodeJS.Platform): boolean {
  return platform === 'linux' ? systemdUserManagerAvailable() : true
}

function scheduleValues(): ScheduleRenderValues {
  const identity = runningInstallationIdentity(import.meta.dir, process.env)
  return {
    bottegaBin: process.execPath,
    installationRoot: identity.root,
    home: homedir(),
    stateHomeEnvironment: STATE_HOME_ENV,
    stateHome: resolveStateRoot(process.env),
  }
}

export function gatherScheduleSetupFacts(): ScheduleSetupFact[] {
  if (!schedulePlatformSupported(process.platform)) return []
  const values = scheduleValues()
  switch (process.platform) {
    case 'darwin':
      return gatherLaunchdScheduleSetupFacts(values)
    case 'linux':
      return gatherSystemdScheduleSetupFacts(values)
    default:
      throw new Error(`maintenance schedule adapter missing for ${process.platform}`)
  }
}

export async function applyMaintenanceSchedules(): Promise<ScheduleApplyResult[]> {
  if (!schedulePlatformSupported(process.platform)) return []
  const values = scheduleValues()
  switch (process.platform) {
    case 'darwin':
      return applyLaunchdMaintenanceSchedules(values)
    case 'linux':
      return applySystemdMaintenanceSchedules(values)
    default:
      throw new Error(`maintenance schedule adapter missing for ${process.platform}`)
  }
}

/** Restart active long-running maintenance services through the current platform adapter. */
export function restartLongRunningMaintenanceSchedules(
  launchdLoaded: (label: string) => boolean | null,
): LongRunningScheduleRestartResult[] {
  switch (process.platform) {
    case 'darwin':
      return restartLongRunningLaunchdSchedules({ loaded: launchdLoaded })
    case 'linux':
      restartLongRunningSystemdSchedules()
      return []
    default:
      return []
  }
}

export function gatherScheduleLingerFact(): boolean | null {
  return process.platform === 'linux' ? gatherSystemdScheduleLingerFact() : null
}

export function gatherScheduleUserFact(): string | null {
  return process.platform === 'linux' ? gatherSystemdScheduleUserFact() : null
}
