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
} from './setup-schedules.ts'
import {
  applySystemdMaintenanceSchedules,
  gatherScheduleLingerFact as gatherSystemdScheduleLingerFact,
  gatherSystemdScheduleSetupFacts,
  gatherScheduleUserFact as gatherSystemdScheduleUserFact,
  systemdUserManagerAvailable,
} from './setup-systemd-schedules.ts'

export { systemdUserManagerAvailable }

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

export function gatherScheduleLingerFact(): boolean | null {
  return process.platform === 'linux' ? gatherSystemdScheduleLingerFact() : null
}

export function gatherScheduleUserFact(): string | null {
  return process.platform === 'linux' ? gatherSystemdScheduleUserFact() : null
}
